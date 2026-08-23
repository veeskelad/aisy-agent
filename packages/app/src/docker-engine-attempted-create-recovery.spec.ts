import { mkdtempSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DOCKER_CONTAINER_REQUIRED_MASKED_PATHS_V2,
  DOCKER_CONTAINER_REQUIRED_READONLY_PATHS_V2,
} from './docker-container-selected-projection.js'
import {
  computeDockerEngineUnixSocketBindingHash,
  isNodeOwnedDockerEngineAttemptedCreateRecoveryBroker,
  makeNodeOwnedDockerEngineAttemptedCreateRecoveryBroker,
  makeNodeOwnedDockerEngineRecoveryBroker,
  type DockerEnginePinnedEndpointIdentityV1,
} from './docker-engine-pinned-session.js'
import { normalizeOwnedDockerContainerInspectV2 } from './execution-owned-docker-observed-v2.js'
import {
  OWNED_DOCKER_LEDGER_FILENAME,
  initializeOwnedDockerResourceLedger,
  openActivatedOwnedDockerResourceLedger,
  reconcileOwnedDockerResources,
  type OwnedDockerAttestedCommandPort,
  type OwnedDockerCreateDescriptorV2,
  type OwnedDockerRecoveryLedger,
  type OwnedDockerResourceKind,
} from './execution-owned-docker-resources.js'

const SERVER_ID = 'docker-engine-primary'
const SERVER_VERSION = '29.5.2'
const CONTAINER_ID = 'a'.repeat(64)
const OTHER_ID = 'b'.repeat(64)
const IMAGE_ID = `sha256:${'d'.repeat(64)}`
const IMAGE_REFERENCE = `registry.example/aisy/worker@sha256:${'c'.repeat(64)}`
const TMPFS = 'rw,nosuid,nodev,noexec,size=67108864,mode=0700'
const cleanups: Array<() => Promise<void> | void> = []

type EngineMode =
  | 'found'
  | 'not-yet-visible'
  | 'id-404'
  | 'id-mismatch'
  | 'projection-mismatch'
  | 'malformed'
  | 'oversized'
  | 'endpoint-drift'

interface WireCall {
  readonly method?: string
  readonly url?: string
}

type EngineStage = 'version' | 'info' | 'name' | 'id'

interface EngineFixtureControl {
  readonly blockAt?: EngineStage
  readonly replaceSocketAt?: 'info' | 'name'
}

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return Object.freeze({ promise, resolve })
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function root(prefix: string): string {
  const value = realpathSync.native(mkdtempSync(join(tmpdir(), `aisy-${prefix}-`)))
  cleanups.push(() => rmSync(value, { recursive: true, force: true }))
  return value
}

function identity(socketPath: string): DockerEnginePinnedEndpointIdentityV1 {
  return Object.freeze({
    version: 1,
    endpointBindingHash: computeDockerEngineUnixSocketBindingHash(socketPath),
    serverId: SERVER_ID,
    serverVersion: SERVER_VERSION,
    apiVersion: '1.54',
  })
}

function labels(descriptor?: OwnedDockerCreateDescriptorV2): Record<string, string> {
  if (descriptor !== undefined) {
    return {
      'com.aisy.resource.version': descriptor.labels.version,
      'com.aisy.resource.installation': descriptor.labels.installationId,
      'com.aisy.resource.owner': descriptor.labels.ownerBindingHash,
      'com.aisy.resource.session': descriptor.labels.sessionBindingHash,
      'com.aisy.resource.operation': descriptor.labels.operationBindingHash,
      'com.aisy.resource.kind': descriptor.labels.sidecarKind,
      'com.aisy.resource.role': descriptor.labels.role,
      'com.aisy.resource.policy': descriptor.labels.policyHash,
    }
  }
  return {
    'com.aisy.resource.version': '1',
    'com.aisy.resource.installation': '1'.repeat(64),
    'com.aisy.resource.owner': '2'.repeat(64),
    'com.aisy.resource.session': '3'.repeat(64),
    'com.aisy.resource.operation': '4'.repeat(64),
    'com.aisy.resource.kind': 'lease-bound-docker-bash',
    'com.aisy.resource.role': 'worker',
    'com.aisy.resource.policy': '5'.repeat(64),
  }
}

function containerDocument(
  descriptor?: OwnedDockerCreateDescriptorV2,
  overrides: Readonly<{ id?: string; command?: string }> = {},
): Record<string, unknown> {
  return {
    Id: overrides.id ?? CONTAINER_ID,
    Name: `/${descriptor?.name ?? 'aisy-bash-worker-1234567890abcdef12345678'}`,
    Image: IMAGE_ID,
    Config: {
      Image: IMAGE_REFERENCE,
      User: '65532:65532',
      Env: ['LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'PATH=/usr/bin'],
      Entrypoint: ['/bin/sh'],
      Cmd: ['-lc', overrides.command ?? 'printf safe'],
      WorkingDir: '/work',
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
      Labels: labels(descriptor),
      Healthcheck: { Test: ['NONE'] },
      StopSignal: 'SIGTERM',
    },
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false,
      CapAdd: [], CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges=true', 'seccomp=builtin'],
      GroupAdd: [], Sysctls: {}, MaskedPaths: [...DOCKER_CONTAINER_REQUIRED_MASKED_PATHS_V2],
      ReadonlyPaths: [...DOCKER_CONTAINER_REQUIRED_READONLY_PATHS_V2],
      IpcMode: 'none', PidMode: '', UTSMode: '', CgroupnsMode: 'private', UsernsMode: '',
      PidsLimit: 128, Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000, Runtime: 'runsc',
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false,
      LogConfig: { Type: 'local', Config: {
        'max-size': '1048576', 'max-file': '1', compress: 'false',
      } },
      Tmpfs: { '/tmp': TMPFS }, Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
      Devices: [], DeviceRequests: [], PortBindings: {}, PublishAllPorts: false,
      OomKillDisable: false, OomScoreAdj: 0, ShmSize: 64 * 1024 * 1024, Init: false,
    },
    Mounts: [{
      Type: 'bind', Source: '/private/work', Destination: '/work', RW: true,
      Propagation: 'rprivate',
    }],
  }
}

async function engineFixture(
  initialMode: EngineMode = 'found',
  control: EngineFixtureControl = {},
): Promise<Readonly<{
  socketPath: string
  wire: WireCall[]
  sockets: Set<Socket>
  blocked: Promise<void>
  releaseBlock(): void
  setDescriptor(value: OwnedDockerCreateDescriptorV2): void
  resetMetrics(): void
  getConnections(): number
  getReplacementRequests(): number
}>> {
  // ponytail: короткий префикс — sun_path на macOS ограничен 104 байтами
  const engineRoot = root('att-rec-eng')
  const socketPath = join(engineRoot, 'engine.sock')
  const wire: WireCall[] = []
  const sockets = new Set<Socket>()
  let connections = 0
  let replacementRequests = 0
  let descriptor: OwnedDockerCreateDescriptorV2 | undefined
  let recoveryActivated = false
  const blocked = deferred()
  const release = deferred()
  const json = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  const replaceSocket = async (): Promise<void> => {
    unlinkSync(socketPath)
    const replacement = createServer((_request, response) => {
      replacementRequests += 1
      json(response, 500, { message: 'replacement must not be contacted' })
    })
    await listen(replacement, socketPath)
    cleanups.push(async () => {
      replacement.closeAllConnections()
      if (replacement.listening) {
        await new Promise<void>(resolve => replacement.close(() => resolve()))
      }
    })
  }
  const respond = (
    stage: EngineStage,
    response: ServerResponse,
    status: number,
    value: unknown,
  ): void => {
    const complete = async (): Promise<void> => {
      if (recoveryActivated && control.replaceSocketAt === stage) await replaceSocket()
      json(response, status, value)
    }
    if (recoveryActivated && control.blockAt === stage) {
      blocked.resolve()
      void release.promise.then(complete)
      return
    }
    void complete()
  }
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    wire.push({
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(request.url === undefined ? {} : { url: request.url }),
    })
    sockets.add(request.socket)
    if (request.url === '/v1.54/version') {
      return respond('version', response, 200, {
        Version: SERVER_VERSION, ApiVersion: '1.55', MinAPIVersion: '1.40',
      })
    }
    if (request.url === '/v1.54/info') {
      return respond('info', response, 200, {
        ID: recoveryActivated && initialMode === 'endpoint-drift' ? 'replacement-engine' : SERVER_ID,
        ServerVersion: SERVER_VERSION,
      })
    }
    if (request.method !== 'GET') return json(response, 405, {})
    if (request.url?.includes('/containers/json?') || request.url?.includes('/networks?')) {
      if (request.url.includes('/networks?')) recoveryActivated = true
      return json(response, 200, [])
    }
    if (descriptor === undefined) return json(response, 500, {})
    const immutablePath = `/v1.54/containers/${CONTAINER_ID}/json`
    if (request.url !== immutablePath) {
      if (initialMode === 'not-yet-visible') {
        return respond('name', response, 404, { message: 'missing' })
      }
      if (initialMode === 'malformed') return respond('name', response, 200, { Id: CONTAINER_ID })
      if (initialMode === 'oversized') {
        return respond('name', response, 200, { oversized: 'x'.repeat(300 * 1024) })
      }
      return respond('name', response, 200, containerDocument(descriptor))
    }
    if (initialMode === 'id-404') return respond('id', response, 404, { message: 'gone' })
    if (initialMode === 'id-mismatch') {
      return respond('id', response, 200, containerDocument(descriptor, { id: OTHER_ID }))
    }
    if (initialMode === 'projection-mismatch') {
      return respond('id', response, 200, containerDocument(descriptor, { command: 'printf changed' }))
    }
    return respond('id', response, 200, containerDocument(descriptor))
  })
  server.on('connection', () => { connections += 1 })
  await listen(server, socketPath)
  cleanups.push(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return Object.freeze({
    socketPath,
    wire,
    sockets,
    blocked: blocked.promise,
    releaseBlock() { release.resolve() },
    setDescriptor(value: OwnedDockerCreateDescriptorV2) { descriptor = value },
    resetMetrics() {
      wire.length = 0
      sockets.clear()
      connections = 0
    },
    getConnections: () => connections,
    getReplacementRequests: () => replacementRequests,
  })
}

function emptyDocker(socketPath: string, scanAmbiguous = false): OwnedDockerAttestedCommandPort {
  return {
    endpointIdentity: identity(socketPath),
    async probe() { return { kind: 'compatible' as const } },
    async scanInstallation() {
      return scanAmbiguous
        ? { kind: 'ambiguous' as const }
        : { kind: 'ok' as const, resources: Object.freeze([]) }
    },
    async inspectById(_input: Readonly<{ resourceKind: OwnedDockerResourceKind; objectId: string }>) {
      return { kind: 'absent' as const }
    },
    async inspectByName(_input: Readonly<{ resourceKind: OwnedDockerResourceKind; name: string }>) {
      return { kind: 'absent' as const }
    },
    async removeById(_input: Readonly<{ resourceKind: OwnedDockerResourceKind; objectId: string }>) {
      return { kind: 'absent' as const }
    },
  }
}

async function attemptedAuthority(socketPath: string): Promise<Readonly<{
  ledger: OwnedDockerRecoveryLedger
  ledgerPath: string
  operationBindingHash: string
}>> {
  const ledgerRoot = join(root('attempted-recovery-ledger'), 'ledger')
  const activation = initializeOwnedDockerResourceLedger({
    root: ledgerRoot,
    installationId: '1'.repeat(64),
    endpointIdentity: identity(socketPath),
  })
  let ledger = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
  const docker = emptyDocker(socketPath)
  await reconcileOwnedDockerResources({ ledger, docker })
  const recovery = makeNodeOwnedDockerEngineRecoveryBroker({
    socketPath,
    endpointIdentity: identity(socketPath),
    authority: ledger,
    timeoutMs: 1_000,
  })
  const active = (await ledger.activateAfterInstallationZero(docker, recovery)).activeEpoch
  const projection = normalizeOwnedDockerContainerInspectV2(containerDocument())
  const operation = active.prepare({
    version: 2,
    sidecarKind: 'lease-bound-docker-bash',
    policyHash: '5'.repeat(64),
    resources: [{
      version: 2,
      role: 'worker',
      resourceKind: 'container',
      createProjectionContract: 'container-selected-v2',
      createProjectionHash: projection.createProjectionHash,
    }],
  })
  await expect(operation.create('worker', async () => {
    throw new Error('create response lost')
  })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
  ledger.close()
  ledger = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
  await expect(reconcileOwnedDockerResources({
    ledger, docker: emptyDocker(socketPath),
  })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
  cleanups.push(() => ledger.close())
  return Object.freeze({
    ledger,
    ledgerPath: join(ledgerRoot, OWNED_DOCKER_LEDGER_FILENAME),
    operationBindingHash: operation.operationBindingHash,
  })
}

function broker(
  socketPath: string,
  authority: OwnedDockerRecoveryLedger,
  timeoutMs = 1_000,
) {
  return makeNodeOwnedDockerEngineAttemptedCreateRecoveryBroker({
    socketPath,
    endpointIdentity: identity(socketPath),
    authority,
    timeoutMs,
  })
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe('attempted Docker create restart-recovery transport', () => {
  it('discovers and binds exact ownership without any mutation on one pinned socket', async () => {
    const engine = await engineFixture()
    const authority = await attemptedAuthority(engine.socketPath)
    const recovery = broker(engine.socketPath, authority.ledger)
    engine.resetMetrics()

    await expect(authority.ledger.recoverAttemptedContainer(
      authority.operationBindingHash,
      async (descriptor, permit) => {
        engine.setDescriptor(descriptor)
        return recovery.inspectExact(permit)
      },
    )).resolves.toEqual({ kind: 'bound' })

    expect(engine.wire).toEqual([
      { method: 'GET', url: '/v1.54/version' },
      { method: 'GET', url: '/v1.54/info' },
      {
        method: 'GET',
        url: expect.stringMatching(
          /^\/v1\.54\/containers\/aisy-bash-worker-[a-f0-9]{24}\/json$/,
        ),
      },
      { method: 'GET', url: `/v1.54/containers/${CONTAINER_ID}/json` },
    ])
    expect(engine.wire.every(call => call.method === 'GET')).toBe(true)
    expect(engine.getConnections()).toBe(1)
    expect(engine.sockets.size).toBe(1)
    expect(authority.ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: CONTAINER_ID,
      boundProjectionHashV1: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it('returns genuine not-yet-visible on name 404 and preserves attempted intent', async () => {
    const engine = await engineFixture('not-yet-visible')
    const authority = await attemptedAuthority(engine.socketPath)
    const recovery = broker(engine.socketPath, authority.ledger)
    engine.resetMetrics()

    await expect(authority.ledger.recoverAttemptedContainer(
      authority.operationBindingHash,
      async (descriptor, permit) => {
        engine.setDescriptor(descriptor)
        return recovery.inspectExact(permit)
      },
    )).resolves.toEqual({ kind: 'not-yet-visible' })

    expect(engine.wire).toHaveLength(3)
    expect(engine.wire.every(call => call.method === 'GET')).toBe(true)
    expect(authority.ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'attempted', objectId: null, boundProjectionHashV1: null,
    })
  })

  it.each([
    ['immutable ID disappears', 'id-404', 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN'],
    ['immutable ID changes', 'id-mismatch', 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN'],
    ['immutable projection changes', 'projection-mismatch', 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN'],
    ['name inspect is malformed', 'malformed', 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_OWNERSHIP_UNPROVEN'],
    ['name inspect is oversized', 'oversized', 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_DAEMON_AMBIGUOUS'],
    ['endpoint drifts at info', 'endpoint-drift', 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ENDPOINT_MISMATCH'],
  ] as const)('%s without binding or mutation', async (_name, mode, code) => {
    const engine = await engineFixture(mode)
    const authority = await attemptedAuthority(engine.socketPath)
    const recovery = broker(engine.socketPath, authority.ledger)
    engine.resetMetrics()
    let transportError: unknown

    await expect(authority.ledger.recoverAttemptedContainer(
      authority.operationBindingHash,
      async (descriptor, permit) => {
        engine.setDescriptor(descriptor)
        try {
          return await recovery.inspectExact(permit)
        } catch (error) {
          transportError = error
          throw error
        }
      },
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })

    expect(transportError).toMatchObject({ code })
    expect(engine.wire.every(call => call.method === 'GET')).toBe(true)
    expect(authority.ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'attempted', objectId: null, boundProjectionHashV1: null,
    })
  })

  it('rejects forged and replayed permits after preflight with zero object I/O', async () => {
    const engine = await engineFixture('not-yet-visible')
    const authority = await attemptedAuthority(engine.socketPath)
    let recovery = broker(engine.socketPath, authority.ledger)
    engine.resetMetrics()

    await expect(recovery.inspectExact({} as never)).rejects.toMatchObject({
      code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_INPUT_INVALID',
    })
    expect(engine.wire.map(call => call.url)).toEqual(['/v1.54/version', '/v1.54/info'])

    let usedPermit: Parameters<typeof recovery.inspectExact>[0] | undefined
    recovery = broker(engine.socketPath, authority.ledger)
    await authority.ledger.recoverAttemptedContainer(
      authority.operationBindingHash,
      async (descriptor, permit) => {
        engine.setDescriptor(descriptor)
        usedPermit = permit
        return recovery.inspectExact(permit)
      },
    )
    engine.resetMetrics()
    const replay = broker(engine.socketPath, authority.ledger)
    await expect(replay.inspectExact(usedPermit!)).rejects.toMatchObject({
      code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_INPUT_INVALID',
    })
    expect(engine.wire.map(call => call.url)).toEqual(['/v1.54/version', '/v1.54/info'])
  })

  it('burns a cross-ledger permit without object I/O in either ledger', async () => {
    const engine = await engineFixture()
    const first = await attemptedAuthority(engine.socketPath)
    const second = await attemptedAuthority(engine.socketPath)
    const wrongAuthorityBroker = broker(engine.socketPath, first.ledger)
    engine.resetMetrics()
    let transportError: unknown

    await expect(second.ledger.recoverAttemptedContainer(
      second.operationBindingHash,
      async (_descriptor, permit) => {
        try {
          return await wrongAuthorityBroker.inspectExact(permit)
        } catch (error) {
          transportError = error
          throw error
        }
      },
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })

    expect(transportError).toMatchObject({
      code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_INPUT_INVALID',
    })
    expect(engine.wire.map(call => call.url)).toEqual(['/v1.54/version', '/v1.54/info'])
    for (const authority of [first, second]) {
      expect(authority.ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
    }
  })

  it('aborts a blocked name inspect without binding and preserves attempted intent', async () => {
    const engine = await engineFixture('found', { blockAt: 'name' })
    const authority = await attemptedAuthority(engine.socketPath)
    const recovery = broker(engine.socketPath, authority.ledger)
    const controller = new AbortController()
    let transportError: unknown
    engine.resetMetrics()

    const pending = authority.ledger.recoverAttemptedContainer(
      authority.operationBindingHash,
      async (descriptor, permit) => {
        engine.setDescriptor(descriptor)
        try {
          return await recovery.inspectExact(permit, { signal: controller.signal })
        } catch (error) {
          transportError = error
          throw error
        }
      },
    )
    await engine.blocked
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })
    engine.releaseBlock()
    expect(transportError).toMatchObject({
      code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ABORTED',
    })
    expect(engine.wire.map(call => call.url)).toEqual([
      '/v1.54/version',
      '/v1.54/info',
      expect.stringMatching(/^\/v1\.54\/containers\/aisy-bash-worker-[a-f0-9]{24}\/json$/),
    ])
    expect(authority.ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'attempted', objectId: null, boundProjectionHashV1: null,
    })
  })

  it('times out a blocked inspect without binding or issuing immutable-ID I/O', async () => {
    const engine = await engineFixture('found', { blockAt: 'name' })
    const authority = await attemptedAuthority(engine.socketPath)
    const recovery = broker(engine.socketPath, authority.ledger, 20)
    let transportError: unknown
    engine.resetMetrics()

    const pending = authority.ledger.recoverAttemptedContainer(
      authority.operationBindingHash,
      async (descriptor, permit) => {
        engine.setDescriptor(descriptor)
        try {
          return await recovery.inspectExact(permit)
        } catch (error) {
          transportError = error
          throw error
        }
      },
    )
    await engine.blocked

    await expect(pending).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })
    engine.releaseBlock()
    expect(transportError).toMatchObject({
      code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_DAEMON_AMBIGUOUS',
    })
    expect(engine.wire).toHaveLength(3)
    expect(engine.wire.every(call => call.method === 'GET')).toBe(true)
    expect(authority.ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'attempted', objectId: null, boundProjectionHashV1: null,
    })
  })

  it('holds recovery authority across awaited inspect and prevents mid-flight activation or close', async () => {
    const engine = await engineFixture('found', { blockAt: 'name' })
    const authority = await attemptedAuthority(engine.socketPath)
    const recovery = broker(engine.socketPath, authority.ledger)
    engine.resetMetrics()

    const pending = authority.ledger.recoverAttemptedContainer(
      authority.operationBindingHash,
      async (descriptor, permit) => {
        engine.setDescriptor(descriptor)
        return recovery.inspectExact(permit)
      },
    )
    await engine.blocked

    await expect(reconcileOwnedDockerResources({
      ledger: authority.ledger,
      docker: emptyDocker(engine.socketPath),
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    expect(() => authority.ledger.close()).toThrowError(expect.objectContaining({
      code: 'OWNED_DOCKER_LEDGER_BUSY',
    }))

    engine.releaseBlock()
    await expect(pending).resolves.toEqual({ kind: 'bound' })
    expect(authority.ledger.listOperations()[0]!.resources[0]!.phase).toBe('bound')
  })

  it('detects forced authority loss after awaited name inspect without binding', async () => {
    const engine = await engineFixture('found', { blockAt: 'name' })
    const authority = await attemptedAuthority(engine.socketPath)
    const recovery = broker(engine.socketPath, authority.ledger)
    let transportError: unknown
    engine.resetMetrics()

    const pending = authority.ledger.recoverAttemptedContainer(
      authority.operationBindingHash,
      async (descriptor, permit) => {
        engine.setDescriptor(descriptor)
        try {
          return await recovery.inspectExact(permit)
        } catch (error) {
          transportError = error
          throw error
        }
      },
    )
    await engine.blocked
    const external = new Database(authority.ledgerPath)
    external.prepare('UPDATE ledger_meta SET manager_epoch = manager_epoch + 1 WHERE singleton = 1').run()
    external.close()
    engine.releaseBlock()

    await expect(pending).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })
    expect(transportError).toMatchObject({
      code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_AUTHORITY_LOST',
    })
    const evidence = new Database(authority.ledgerPath, { readonly: true })
    expect(evidence.prepare(
      "SELECT phase, object_id, bound_projection_hash_v1 FROM resources WHERE role = 'worker'",
    ).get()).toEqual({ phase: 'attempted', object_id: null, bound_projection_hash_v1: null })
    evidence.close()
  })

  it.each([
    ['after preflight', 'info', 2],
    ['after name inspect', 'name', 3],
  ] as const)(
    'rejects socket path replacement %s without contacting the replacement or binding',
    async (_name, replaceSocketAt, expectedCalls) => {
      const engine = await engineFixture('found', { replaceSocketAt })
      const authority = await attemptedAuthority(engine.socketPath)
      const recovery = broker(engine.socketPath, authority.ledger)
      let transportError: unknown
      engine.resetMetrics()

      await expect(authority.ledger.recoverAttemptedContainer(
        authority.operationBindingHash,
        async (descriptor, permit) => {
          engine.setDescriptor(descriptor)
          try {
            return await recovery.inspectExact(permit)
          } catch (error) {
            transportError = error
            throw error
          }
        },
      )).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })

      expect(transportError).toMatchObject({
        code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_DAEMON_AMBIGUOUS',
      })
      expect(engine.wire).toHaveLength(expectedCalls)
      expect(engine.wire.every(call => call.method === 'GET')).toBe(true)
      expect(engine.getReplacementRequests()).toBe(0)
      expect(authority.ledger.listOperations()[0]!.resources[0]).toMatchObject({
        phase: 'attempted', objectId: null, boundProjectionHashV1: null,
      })
    },
  )

  it('drains close behind an in-flight inspect and stays closed afterwards', async () => {
    const engine = await engineFixture('not-yet-visible', { blockAt: 'name' })
    const authority = await attemptedAuthority(engine.socketPath)
    const recovery = broker(engine.socketPath, authority.ledger)
    engine.resetMetrics()

    const pending = authority.ledger.recoverAttemptedContainer(
      authority.operationBindingHash,
      async (descriptor, permit) => {
        engine.setDescriptor(descriptor)
        return recovery.inspectExact(permit)
      },
    )
    await engine.blocked
    const closing = recovery.close()
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    await expect(recovery.inspectExact({} as never)).rejects.toMatchObject({
      code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_CLOSED',
    })

    engine.releaseBlock()
    await expect(pending).resolves.toEqual({ kind: 'not-yet-visible' })
    await expect(closing).resolves.toBeUndefined()
    await expect(recovery.close()).resolves.toBeUndefined()
    await expect(recovery.inspectExact({} as never)).rejects.toMatchObject({
      code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_CLOSED',
    })
    expect(authority.ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
  })

  it('honors pre-abort, one-shot lifecycle and structural brand checks', async () => {
    const engine = await engineFixture()
    const authority = await attemptedAuthority(engine.socketPath)
    const recovery = broker(engine.socketPath, authority.ledger)
    const controller = new AbortController()
    controller.abort()
    engine.resetMetrics()

    expect(isNodeOwnedDockerEngineAttemptedCreateRecoveryBroker(recovery)).toBe(true)
    expect(isNodeOwnedDockerEngineAttemptedCreateRecoveryBroker({ ...recovery })).toBe(false)
    await expect(recovery.inspectExact({} as never, { signal: controller.signal }))
      .rejects.toMatchObject({
        code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ABORTED',
      })
    expect(engine.wire).toEqual([])
    await expect(recovery.inspectExact({} as never)).rejects.toMatchObject({
      code: 'OWNED_DOCKER_ATTEMPTED_CREATE_RECOVERY_BROKER_ALREADY_USED',
    })
    await recovery.close()
  })
})

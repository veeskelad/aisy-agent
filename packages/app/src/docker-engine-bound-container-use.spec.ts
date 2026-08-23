import { createServer, type Server, type ServerResponse } from 'node:http'
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import {
  computeDockerEngineUnixSocketBindingHash,
  isNodeDockerEngineBoundContainerUseBroker,
  makeNodeDockerEngineBoundContainerUseBroker,
  makeNodeOwnedDockerEngineRecoveryBroker,
  type DockerEnginePinnedEndpointIdentityV1,
} from './docker-engine-pinned-session.js'
import {
  initializeOwnedDockerResourceLedger,
  openActivatedOwnedDockerResourceLedger,
  reconcileOwnedDockerResources,
  type OwnedDockerAttestedCommandPort,
  type OwnedDockerBoundContainerUsePermitV1,
  type OwnedDockerCreateDescriptorV2,
  type OwnedDockerObservedResourceV2,
  type OwnedDockerResourceKind,
} from './execution-owned-docker-resources.js'
import {
  DOCKER_CONTAINER_REQUIRED_MASKED_PATHS_V2,
  DOCKER_CONTAINER_REQUIRED_READONLY_PATHS_V2,
} from './docker-container-selected-projection.js'
import { normalizeOwnedDockerContainerInspectV2 } from './execution-owned-docker-observed-v2.js'

const SERVER_VERSION = '29.5.2'
const SERVER_ID = 'docker-engine-bound-use'
const CONTAINER_ID = 'd'.repeat(64)
const IMAGE_ID = `sha256:${'a'.repeat(64)}`
const IMAGE_REFERENCE = `registry.example/aisy/bash@sha256:${'b'.repeat(64)}`
const INSTALLATION_ID = '1'.repeat(64)
const POLICY_HASH = '5'.repeat(64)
const TMPFS = 'rw,nosuid,nodev,noexec,size=67108864,mode=0700'
const roots: string[] = []
const closeables: Array<() => void | Promise<void>> = []

function root(prefix: string): string {
  const value = realpathSync.native(mkdtempSync(join(tmpdir(), `aisy-${prefix}-`)))
  roots.push(value)
  return value
}

afterEach(async () => {
  for (const close of closeables.splice(0).reverse()) {
    try { await close() } catch { /* test cleanup */ }
  }
  for (const value of roots.splice(0).reverse()) rmSync(value, { recursive: true, force: true })
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function ownership(descriptor?: OwnedDockerCreateDescriptorV2): Record<string, string> {
  const labels = descriptor?.labels
  return {
    'com.aisy.resource.version': labels?.version ?? '1',
    'com.aisy.resource.installation': labels?.installationId ?? INSTALLATION_ID,
    'com.aisy.resource.owner': labels?.ownerBindingHash ?? '2'.repeat(64),
    'com.aisy.resource.session': labels?.sessionBindingHash ?? '3'.repeat(64),
    'com.aisy.resource.operation': labels?.operationBindingHash ?? '4'.repeat(64),
    'com.aisy.resource.kind': labels?.sidecarKind ?? 'lease-bound-docker-bash',
    'com.aisy.resource.role': labels?.role ?? 'worker',
    'com.aisy.resource.policy': labels?.policyHash ?? POLICY_HASH,
  }
}

function containerDocument(
  descriptor?: OwnedDockerCreateDescriptorV2,
  state: 'created' | 'exited' = 'created',
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
      Labels: { ...ownership(descriptor), 'org.opencontainers.image.title': 'aisy-worker' },
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
    State: state === 'created'
      ? { Status: 'created', Running: false, Dead: false, OOMKilled: false, ExitCode: 0, Error: '' }
      : { Status: 'exited', Running: false, Dead: false, OOMKilled: false, ExitCode: 7, Error: '' },
  }
}

function rawFrame(stream: 1 | 2, value: string): Buffer {
  const payload = Buffer.from(value, 'utf8')
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(payload.byteLength, 4)
  return Buffer.concat([header, payload])
}

type EngineMode =
  | 'happy'
  | 'inspect-mismatch'
  | 'final-inspect-mismatch'
  | 'start-conflict'
  | 'start-close'
  | 'wait-hang'
  | 'wait-timeout'
  | 'bad-terminal'
  | 'bad-logs'
  | 'oversize-logs'

interface EngineFixture {
  readonly socketPath: string
  readonly wire: string[]
  readonly waitEntered: Promise<void>
  readonly sockets: Set<Socket>
  get connections(): number
  setDescriptor(value: OwnedDockerCreateDescriptorV2): void
  resetMetrics(): void
}

async function engineFixture(mode: EngineMode): Promise<EngineFixture> {
  const socketPath = join(root('bound-use-engine'), 'engine.sock')
  const wire: string[] = []
  const sockets = new Set<Socket>()
  const wait = deferred()
  let connections = 0
  let descriptor: OwnedDockerCreateDescriptorV2 | undefined
  let phase: 'created' | 'running' | 'exited' = 'created'

  const json = (response: ServerResponse, status: number, value: unknown): void => {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
    })
    response.end(body)
  }
  const server: Server = createServer((request, response) => {
    const method = request.method ?? ''
    const url = request.url ?? ''
    wire.push(`${method} ${url}`)
    request.resume()
    if (url === '/v1.54/version') {
      json(response, 200, { Version: SERVER_VERSION, ApiVersion: '1.54', MinAPIVersion: '1.24' })
      return
    }
    if (url === '/v1.54/info') {
      json(response, 200, { ID: SERVER_ID, ServerVersion: SERVER_VERSION })
      return
    }
    if (url.includes('/containers/json?') || url.includes('/networks?')) {
      json(response, 200, [])
      return
    }
    if (url === `/v1.54/containers/${CONTAINER_ID}/json`) {
      const state = phase === 'exited' && mode !== 'bad-terminal' ? 'exited' : 'created'
      json(response, 200, containerDocument(
        descriptor,
        state,
        mode === 'inspect-mismatch' || (mode === 'final-inspect-mismatch' && phase === 'exited')
          ? { id: 'e'.repeat(64) }
          : {},
      ))
      return
    }
    if (url === `/v1.54/containers/${CONTAINER_ID}/start`) {
      if (mode === 'start-close') {
        request.socket.destroy()
        return
      }
      if (mode === 'start-conflict') {
        json(response, 304, { message: 'already started' })
        return
      }
      phase = 'running'
      response.writeHead(204, { 'content-length': '0' })
      response.end()
      return
    }
    if (url === `/v1.54/containers/${CONTAINER_ID}/wait?condition=not-running`) {
      wait.resolve()
      if (mode === 'wait-hang' || mode === 'wait-timeout') return
      phase = 'exited'
      json(response, 200, { StatusCode: 7, Error: null })
      return
    }
    if (url === `/v1.54/containers/${CONTAINER_ID}/logs?follow=0&stdout=1&stderr=1&timestamps=0&tail=all`) {
      if (mode === 'bad-logs') {
        response.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' })
        response.end(Buffer.from([1, 0, 0, 0, 0, 0, 0, 8, 1]))
        return
      }
      const body = mode === 'oversize-logs'
        ? rawFrame(1, 'x'.repeat(4096))
        : Buffer.concat([rawFrame(1, 'safe-out\n'), rawFrame(2, 'safe-err\n')])
      response.writeHead(200, {
        'content-type': 'application/vnd.docker.raw-stream',
        'content-length': String(body.byteLength),
      })
      response.end(body)
      return
    }
    json(response, 404, { message: 'not found' })
  })
  server.on('connection', socket => {
    connections += 1
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      chmodSync(socketPath, 0o600)
      resolve()
    })
  })
  closeables.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return {
    socketPath,
    wire,
    waitEntered: wait.promise,
    sockets,
    get connections() { return connections },
    setDescriptor(value) { descriptor = value },
    resetMetrics() {
      wire.length = 0
      sockets.clear()
      connections = 0
    },
  }
}

function endpointIdentity(socketPath: string): DockerEnginePinnedEndpointIdentityV1 {
  return Object.freeze({
    version: 1,
    endpointBindingHash: computeDockerEngineUnixSocketBindingHash(socketPath),
    serverId: SERVER_ID,
    serverVersion: SERVER_VERSION,
    apiVersion: '1.54',
  })
}

class FakeOwnedDocker implements OwnedDockerAttestedCommandPort {
  readonly resources = new Map<string, OwnedDockerObservedResourceV2>()
  constructor(readonly endpointIdentity: DockerEnginePinnedEndpointIdentityV1) {}
  async probe() { return { kind: 'compatible' as const } }
  async scanInstallation(installationId: string) {
    return { kind: 'ok' as const, resources: [...this.resources.values()].filter(resource =>
      resource.labels.installationId === installationId) }
  }
  async inspectById(input: Readonly<{ resourceKind: OwnedDockerResourceKind; objectId: string }>) {
    const resource = this.resources.get(input.objectId)
    return resource === undefined ? { kind: 'absent' as const } : { kind: 'found' as const, resource }
  }
  async inspectByName(input: Readonly<{ resourceKind: OwnedDockerResourceKind; name: string }>) {
    const resource = [...this.resources.values()].find(item =>
      item.resourceKind === input.resourceKind && item.name === input.name)
    return resource === undefined ? { kind: 'absent' as const } : { kind: 'found' as const, resource }
  }
  async removeById(input: Readonly<{ resourceKind: OwnedDockerResourceKind; objectId: string }>) {
    return this.resources.delete(input.objectId)
      ? { kind: 'removed' as const }
      : { kind: 'absent' as const }
  }
}

async function harness(mode: EngineMode = 'happy') {
  const engine = await engineFixture(mode)
  const identity = endpointIdentity(engine.socketPath)
  const ledgerRoot = join(root('bound-use-ledger'), 'ledger')
  const activation = initializeOwnedDockerResourceLedger({
    root: ledgerRoot,
    installationId: INSTALLATION_ID,
    endpointIdentity: identity,
  })
  const ledger = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
  closeables.push(() => ledger.close())
  const docker = new FakeOwnedDocker(identity)
  await reconcileOwnedDockerResources({ ledger, docker })
  const recovery = makeNodeOwnedDockerEngineRecoveryBroker({
    socketPath: engine.socketPath,
    endpointIdentity: identity,
    authority: ledger,
    timeoutMs: 1_000,
  })
  const active = (await ledger.activateAfterInstallationZero(docker, recovery)).activeEpoch
  const projection = normalizeOwnedDockerContainerInspectV2(containerDocument())
  const operation = active.prepare({
    version: 2,
    sidecarKind: 'lease-bound-docker-bash',
    policyHash: POLICY_HASH,
    resources: [{
      version: 2,
      role: 'worker',
      resourceKind: 'container',
      createProjectionContract: 'container-selected-v2',
      createProjectionHash: projection.createProjectionHash,
    }],
  })
  const bound = await operation.create('worker', async descriptor => {
    engine.setDescriptor(descriptor)
    docker.resources.set(CONTAINER_ID, normalizeOwnedDockerContainerInspectV2(
      containerDocument(descriptor),
    ))
  })
  engine.resetMetrics()
  const broker = makeNodeDockerEngineBoundContainerUseBroker({
    socketPath: engine.socketPath,
    endpointIdentity: identity,
    timeoutMs: 1_000,
    maxResponseBytes: 128 * 1024,
    maxJsonNodes: 8_192,
    wallTimeMs: mode === 'wait-timeout' ? 100 : 5_000,
    maxOutputBytes: mode === 'oversize-logs' ? 1024 : 1024 * 1024,
  })
  closeables.push(() => broker.close())
  return { engine, identity, ledger, docker, operation, bound, broker }
}

describe('pinned bound-container use broker', () => {
  it('rejects hostile options without invoking accessors', async () => {
    const { engine, identity } = await harness()
    let getterCalls = 0
    const hostile = Object.defineProperty({}, 'socketPath', {
      enumerable: true,
      get() { getterCalls += 1; return engine.socketPath },
    })
    expect(() => makeNodeDockerEngineBoundContainerUseBroker(hostile as never))
      .toThrowError(expect.objectContaining({ code: 'DOCKER_ENGINE_BOUND_USE_INPUT_INVALID' }))
    expect(getterCalls).toBe(0)
    expect(() => makeNodeDockerEngineBoundContainerUseBroker(new Proxy({
      socketPath: engine.socketPath,
      endpointIdentity: identity,
      wallTimeMs: 1_000,
      maxOutputBytes: 1_024,
    }, {}))).toThrowError(expect.objectContaining({ code: 'DOCKER_ENGINE_BOUND_USE_INPUT_INVALID' }))
    expect(() => makeNodeDockerEngineBoundContainerUseBroker({
      socketPath: engine.socketPath,
      endpointIdentity: identity,
      wallTimeMs: 0,
      maxOutputBytes: 1_024,
    })).toThrowError(expect.objectContaining({ code: 'DOCKER_ENGINE_BOUND_USE_INPUT_INVALID' }))
  })

  it('runs exact bound container on one socket and returns bounded multiplexed output', async () => {
    const { engine, ledger, bound, broker } = await harness()
    expect(isNodeDockerEngineBoundContainerUseBroker(broker)).toBe(true)
    expect(isNodeDockerEngineBoundContainerUseBroker({ ...broker })).toBe(false)

    await expect(bound.useContainer((_descriptor, permit) => broker.run(permit))).resolves.toEqual({
      stdout: 'safe-out\n',
      stderr: 'safe-err\n',
      exitCode: 7,
    })
    expect(engine.connections).toBe(1)
    expect(engine.wire).toEqual([
      'GET /v1.54/version',
      'GET /v1.54/info',
      `GET /v1.54/containers/${CONTAINER_ID}/json`,
      `POST /v1.54/containers/${CONTAINER_ID}/start`,
      `POST /v1.54/containers/${CONTAINER_ID}/wait?condition=not-running`,
      `GET /v1.54/containers/${CONTAINER_ID}/json`,
      `GET /v1.54/containers/${CONTAINER_ID}/logs?follow=0&stdout=1&stderr=1&timestamps=0&tail=all`,
    ])
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: CONTAINER_ID,
    })
    await expect(bound.useContainer((_descriptor, permit) => broker.run(permit)))
      .rejects.toMatchObject({ code: 'DOCKER_ENGINE_BOUND_USE_ALREADY_USED' })
  })

  it('rejects a structural permit after read-only preflight and sends zero start', async () => {
    const { engine, broker } = await harness()
    const forged = Object.freeze({
      version: 1,
      operationBindingHash: '4'.repeat(64),
      role: 'worker',
      objectId: CONTAINER_ID,
    }) as unknown as OwnedDockerBoundContainerUsePermitV1

    await expect(broker.run(forged)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_BOUND_USE_AUTHORITY_LOST',
    })
    expect(engine.wire).toEqual(['GET /v1.54/version', 'GET /v1.54/info'])
  })

  it('refuses inspect mismatch before mutation and leaves durable bound intent', async () => {
    const { engine, ledger, bound, broker } = await harness('inspect-mismatch')
    await expect(bound.useContainer((_descriptor, permit) => broker.run(permit)))
      .rejects.toMatchObject({ code: 'DOCKER_ENGINE_BOUND_USE_OWNERSHIP_UNPROVEN' })
    expect(engine.wire.some(call => call.endsWith('/start'))).toBe(false)
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: CONTAINER_ID,
    })
  })

  it.each(['start-conflict', 'start-close'] as const)(
    'treats %s after possible POST as unresolved without retry', async mode => {
      const { engine, ledger, bound, broker } = await harness(mode)
      await expect(bound.useContainer((_descriptor, permit) => broker.run(permit)))
        .rejects.toMatchObject({ code: 'DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED' })
      expect(engine.wire.filter(call => call.endsWith('/start'))).toHaveLength(1)
      expect(engine.connections).toBe(1)
      expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
        phase: 'bound', objectId: CONTAINER_ID,
      })
    },
  )

  it.each(['final-inspect-mismatch', 'bad-terminal', 'bad-logs', 'oversize-logs'] as const)(
    'fails closed for %s while preserving restart cleanup intent', async mode => {
      const { ledger, bound, broker } = await harness(mode)
      await expect(bound.useContainer((_descriptor, permit) => broker.run(permit)))
        .rejects.toMatchObject({
          code: mode === 'bad-terminal' || mode === 'final-inspect-mismatch'
            ? 'DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED'
            : 'DOCKER_ENGINE_BOUND_USE_OUTPUT_UNRESOLVED',
        })
      expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
        phase: 'bound', objectId: CONTAINER_ID,
      })
    },
  )

  it('keeps one unresolved start when wait is cancelled', async () => {
    const { engine, ledger, bound, broker } = await harness('wait-hang')
    const controller = new AbortController()
    const running = bound.useContainer((_descriptor, permit) => broker.run(permit, {
      signal: controller.signal,
    }))
    await engine.waitEntered
    const closing = broker.close()
    let closeSettled = false
    void closing.then(() => { closeSettled = true })
    await Promise.resolve()
    expect(closeSettled).toBe(false)
    controller.abort()
    await expect(running).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED',
    })
    expect(engine.wire.filter(call => call.endsWith('/start'))).toHaveLength(1)
    expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('bound')
    await closing
    expect(closeSettled).toBe(true)
  })

  it('times out a hung wait without retry and preserves durable cleanup intent', async () => {
    const { engine, ledger, bound, broker } = await harness('wait-timeout')
    await expect(bound.useContainer((_descriptor, permit) => broker.run(permit)))
      .rejects.toMatchObject({ code: 'DOCKER_ENGINE_BOUND_USE_EXECUTION_UNRESOLVED' })
    expect(engine.wire.filter(call => call.endsWith('/start'))).toHaveLength(1)
    expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('bound')
  })
})

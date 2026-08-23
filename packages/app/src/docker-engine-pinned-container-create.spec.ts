import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createLeaseBoundDockerBashContainerCreatePlan,
  makeNodeDockerCodeOwnedContainerCreateBroker,
  sealDockerCodeOwnedContainerCreatePlan,
  type DockerCodeOwnedContainerCreateSealV1,
} from './docker-code-owned-container-create-plan.js'
import {
  computeDockerEngineUnixSocketBindingHash,
  isDockerEnginePinnedPreparedContainerCreate,
  makeNodeDockerEnginePinnedSession,
  makeNodeOwnedDockerEngineRecoveryBroker,
  prepareNodeDockerEnginePinnedContainerCreate,
  type DockerEnginePinnedEndpointIdentityV1,
  type DockerEnginePinnedJsonObject,
  type DockerEnginePinnedSandboxRuntimeEvidenceV1,
} from './docker-engine-pinned-session.js'
import {
  createDockerImageRuntimeManifest,
  type DockerImageRuntimeManifestV1,
} from './docker-image-runtime-manifest.js'
import { inspectNodeDockerSidecarFilesystemEvidence } from './docker-sidecar-filesystem-evidence.js'
import {
  initializeOwnedDockerResourceLedger,
  openActivatedOwnedDockerResourceLedger,
  reconcileOwnedDockerResources,
  type OwnedDockerActiveEpoch,
  type OwnedDockerAttestedCommandPort,
  type OwnedDockerRecoveryLedger,
  type OwnedDockerResourceKind,
} from './execution-owned-docker-resources.js'
import { makeLeaseBoundDockerBashSemanticPlan } from './whisper-bash-docker-semantic-plans.js'

const SERVER_ID = 'docker-engine-primary'
const SERVER_VERSION = '29.5.2'
const CONTAINER_ID = 'a'.repeat(64)
const OTHER_ID = 'b'.repeat(64)
const IMAGE_ID = `sha256:${'d'.repeat(64)}`
const IMAGE_REFERENCE = `registry.example/aisy/worker@sha256:${'c'.repeat(64)}`
const cleanups: Array<() => Promise<void> | void> = []

type EngineMode =
  | 'success'
  | 'lost-201'
  | 'image-not-found'
  | 'conflict'
  | 'malformed-201'
  | 'inspect-id-mismatch'

interface WireCall {
  readonly method?: string
  readonly url?: string
  readonly headers: IncomingMessage['headers']
  readonly body: string
  readonly ledgerPhase?: string
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

function versionDocument(): Record<string, unknown> {
  return { Version: SERVER_VERSION, ApiVersion: '1.55', MinAPIVersion: '1.40' }
}

function infoDocument(runtime: 'runsc' | 'runc'): Record<string, unknown> {
  return {
    ID: SERVER_ID,
    ServerVersion: SERVER_VERSION,
    SecurityOptions: runtime === 'runsc'
      ? ['name=seccomp,profile=builtin', 'name=userns']
      : ['name=seccomp,profile=builtin', 'name=rootless'],
    Runtimes: runtime === 'runsc' ? { runc: {}, runsc: {} } : { runc: {} },
  }
}

function imageDocument(): Record<string, unknown> {
  return {
    Id: IMAGE_ID,
    RepoDigests: [IMAGE_REFERENCE],
    Architecture: 'arm64',
    Os: 'linux',
    Config: {
      User: '65532:65532',
      Env: ['PATH=/usr/bin', 'LANG=en_US.UTF-8'],
      Entrypoint: ['/worker'],
      Cmd: ['serve'],
      WorkingDir: '/work',
      Labels: { 'org.opencontainers.image.title': 'aisy-worker' },
      Volumes: {},
      ExposedPorts: {},
      Healthcheck: null,
      StopSignal: 'SIGTERM',
      Shell: [],
      OnBuild: [],
    },
  }
}

function inspectFromCreate(
  body: Record<string, unknown>,
  name: string,
  id: string,
): Record<string, unknown> {
  const config = { ...body }
  const requestHost = config['HostConfig'] as Record<string, unknown>
  delete config['HostConfig']
  const hostConfig = { ...requestHost }
  const requestMounts = hostConfig['Mounts'] as Array<Record<string, unknown>>
  delete hostConfig['Mounts']
  return {
    Id: id,
    Name: `/${name}`,
    Image: IMAGE_ID,
    Config: config,
    HostConfig: hostConfig,
    Mounts: requestMounts.map(mount => ({
      Type: mount['Type'],
      Source: mount['Source'],
      Destination: mount['Target'],
      RW: mount['ReadOnly'] === false,
      Propagation: (mount['BindOptions'] as Record<string, unknown>)['Propagation'],
    })),
  }
}

async function engineFixture(initialMode: EngineMode = 'success'): Promise<Readonly<{
  socketPath: string
  wire: WireCall[]
  sockets: Set<Socket>
  setMode(value: EngineMode): void
  setRuntime(value: 'runsc' | 'runc'): void
  setPhaseReader(reader: (() => string | undefined) | undefined): void
  resetMetrics(): void
  getConnections(): number
}>> {
  const engineRoot = root('pinned-create-engine')
  const socketPath = join(engineRoot, 'engine.sock')
  const wire: WireCall[] = []
  const sockets = new Set<Socket>()
  let connections = 0
  let mode = initialMode
  let runtime: 'runsc' | 'runc' = 'runsc'
  let phaseReader: (() => string | undefined) | undefined
  let postedBody: Record<string, unknown> | null = null
  let postedName: string | null = null
  const respond = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  const server = createServer((request, response) => {
    sockets.add(request.socket)
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const ledgerPhase = request.method === 'POST' ? phaseReader?.() : undefined
      wire.push({
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.url === undefined ? {} : { url: request.url }),
        headers: request.headers,
        body,
        ...(ledgerPhase === undefined ? {} : { ledgerPhase }),
      })
      if (request.url === '/v1.54/version') return respond(response, 200, versionDocument())
      if (request.url === '/v1.54/info') return respond(response, 200, infoDocument(runtime))
      if (request.url?.includes('/containers/json?') || request.url?.includes('/networks?')) {
        return respond(response, 200, [])
      }
      if (request.url?.startsWith('/v1.54/images/')) {
        return respond(response, 200, imageDocument())
      }
      if (request.method === 'POST' && request.url?.startsWith('/v1.54/containers/create?')) {
        postedBody = JSON.parse(body) as Record<string, unknown>
        postedName = new URL(request.url, 'http://docker.invalid').searchParams.get('name')
        if (mode === 'lost-201') return request.socket.destroy()
        if (mode === 'image-not-found') return respond(response, 404, { message: 'ignored' })
        if (mode === 'conflict') return respond(response, 409, { message: 'ignored' })
        if (mode === 'malformed-201') return respond(response, 201, { Id: CONTAINER_ID })
        return respond(response, 201, { Id: CONTAINER_ID, Warnings: null })
      }
      if (request.url === `/v1.54/containers/${CONTAINER_ID}/json` &&
        postedBody !== null && postedName !== null) {
        return respond(response, 200, inspectFromCreate(
          postedBody,
          postedName,
          mode === 'inspect-id-mismatch' ? OTHER_ID : CONTAINER_ID,
        ))
      }
      respond(response, 500, {})
    })
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
    setMode(value: EngineMode) { mode = value },
    setRuntime(value: 'runsc' | 'runc') { runtime = value },
    setPhaseReader(reader: (() => string | undefined) | undefined) { phaseReader = reader },
    resetMetrics() {
      wire.length = 0
      sockets.clear()
      connections = 0
    },
    getConnections: () => connections,
  })
}

async function liveEvidence(socketPath: string): Promise<Readonly<{
  manifest: DockerImageRuntimeManifestV1
  runtimeEvidence: DockerEnginePinnedSandboxRuntimeEvidenceV1
}>> {
  const endpointIdentity = identity(socketPath)
  const runtimeSession = makeNodeDockerEnginePinnedSession({
    socketPath, endpointIdentity, timeoutMs: 1_000,
  })
  const imageSession = makeNodeDockerEnginePinnedSession({
    socketPath, endpointIdentity, timeoutMs: 1_000,
  })
  try {
    const runtimeEvidence = await runtimeSession.attestSandboxRuntime()
    const image = await imageSession.inspectImageRuntime(IMAGE_REFERENCE)
    if (image.outcome !== 'found') throw new Error('expected image evidence')
    return Object.freeze({
      manifest: createDockerImageRuntimeManifest(image.evidence),
      runtimeEvidence,
    })
  } finally {
    await runtimeSession.close()
    await imageSession.close()
  }
}

async function activeFor(
  endpointIdentity: DockerEnginePinnedEndpointIdentityV1,
  socketPath: string,
): Promise<Readonly<{
  ledger: OwnedDockerRecoveryLedger
  activeEpoch: OwnedDockerActiveEpoch
}>> {
  const ledgerRoot = join(root('pinned-create-ledger'), 'ledger')
  const activation = initializeOwnedDockerResourceLedger({
    root: ledgerRoot,
    installationId: '1'.repeat(64),
    endpointIdentity,
  })
  const ledger = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
  cleanups.push(() => ledger.close())
  const docker: OwnedDockerAttestedCommandPort = {
    endpointIdentity,
    async probe() { return { kind: 'compatible' as const } },
    async scanInstallation() { return { kind: 'ok' as const, resources: Object.freeze([]) } },
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
  await reconcileOwnedDockerResources({ ledger, docker })
  const recovery = makeNodeOwnedDockerEngineRecoveryBroker({
    socketPath, endpointIdentity, authority: ledger, timeoutMs: 1_000,
  })
  const recovered = await ledger.activateAfterInstallationZero(docker, recovery)
  return Object.freeze({ ledger, activeEpoch: recovered.activeEpoch })
}

async function genuineSeal(engine: Awaited<ReturnType<typeof engineFixture>>): Promise<Readonly<{
  seal: DockerCodeOwnedContainerCreateSealV1
  ledger: OwnedDockerRecoveryLedger
  activeEpoch: OwnedDockerActiveEpoch
  runtimeEvidence: DockerEnginePinnedSandboxRuntimeEvidenceV1
}>> {
  const workspace = root('pinned-create-workspace')
  const filesystem = inspectNodeDockerSidecarFilesystemEvidence({
    kind: 'bash-workspace', root: workspace,
  })
  const { manifest, runtimeEvidence } = await liveEvidence(engine.socketPath)
  const command = 'printf safe'
  const semanticDraft = makeLeaseBoundDockerBashSemanticPlan({
    leaseBindingHash: '2'.repeat(64),
    operationBindingHash: '3'.repeat(64),
    workspaceIdentityHash: filesystem.rootIdentityHash,
    instructionSha256: createHash('sha256').update(command).digest('hex'),
    instructionBytes: Buffer.byteLength(command, 'utf8'),
    isolationProfileSha256: runtimeEvidence.isolationProfileSha256,
    limits: {
      memoryBytes: 512 * 1024 * 1024,
      cpuMillicores: 1_000,
      pids: 128,
      wallTimeMs: 120_000,
      maximumOutputBytes: 1024 * 1024,
    },
  })
  const plan = createLeaseBoundDockerBashContainerCreatePlan({
    semanticDraft,
    imageManifest: manifest,
    filesystem,
    command,
    runtimeEvidence,
  })
  const { ledger, activeEpoch } = await activeFor(plan.endpointIdentity, engine.socketPath)
  const seal = sealDockerCodeOwnedContainerCreatePlan({ plan, activeEpoch })
  return Object.freeze({ seal, ledger, activeEpoch, runtimeEvidence })
}

function minimalBody(): DockerEnginePinnedJsonObject {
  return Object.freeze({ Image: IMAGE_REFERENCE })
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe('pinned prepared Docker container create transport', () => {
  it('posts only with a genuine seal and attempted permit on one pinned socket', async () => {
    const engine = await engineFixture()
    const setup = await genuineSeal(engine)
    engine.setPhaseReader(() => setup.ledger.listOperations()[0]?.resources[0]?.phase)
    engine.resetMetrics()
    const broker = makeNodeDockerCodeOwnedContainerCreateBroker({
      seal: setup.seal,
      socketPath: engine.socketPath,
      timeoutMs: 1_000,
    })

    await expect(broker.create()).resolves.toEqual({ kind: 'created-and-bound' })

    expect(engine.wire.map(call => ({ method: call.method, url: call.url }))).toEqual([
      { method: 'GET', url: '/v1.54/version' },
      { method: 'GET', url: '/v1.54/info' },
      {
        method: 'POST',
        url: expect.stringMatching(
          /^\/v1\.54\/containers\/create\?name=aisy-bash-worker-[a-f0-9]{24}&platform=linux%2Farm64$/,
        ),
      },
      { method: 'GET', url: `/v1.54/containers/${CONTAINER_ID}/json` },
    ])
    expect(engine.getConnections()).toBe(1)
    expect(engine.sockets.size).toBe(1)
    const post = engine.wire[2]!
    expect(post.ledgerPhase).toBe('attempted')
    expect(post.headers['content-type']).toBe('application/json')
    expect(post.headers.accept).toBe('application/json')
    expect(Number(post.headers['content-length'])).toBe(Buffer.byteLength(post.body, 'utf8'))
    expect(JSON.parse(post.body)).toMatchObject({ Image: IMAGE_REFERENCE })
    expect(setup.ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: CONTAINER_ID,
    })
  })

  it('rejects runtime drift during preflight before permit consumption or POST', async () => {
    const engine = await engineFixture()
    const setup = await genuineSeal(engine)
    engine.setRuntime('runc')
    engine.resetMetrics()
    const broker = makeNodeDockerCodeOwnedContainerCreateBroker({
      seal: setup.seal, socketPath: engine.socketPath,
    })

    await expect(broker.create()).rejects.toMatchObject({
      code: 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_PREFLIGHT_FAILED',
    })
    expect(engine.wire.map(call => call.url)).toEqual(['/v1.54/version', '/v1.54/info'])
    expect(setup.ledger.listOperations()[0]!.resources[0]!.phase).toBe('prepared')
  })

  it.each([
    ['lost-201', 'lost-201'],
    ['404', 'image-not-found'],
    ['409', 'conflict'],
    ['malformed 201', 'malformed-201'],
    ['inspect ID mismatch', 'inspect-id-mismatch'],
  ] as const)('leaves %s unresolved after exactly one POST', async (_name, mode) => {
    const engine = await engineFixture(mode)
    const setup = await genuineSeal(engine)
    engine.resetMetrics()
    const broker = makeNodeDockerCodeOwnedContainerCreateBroker({
      seal: setup.seal, socketPath: engine.socketPath, timeoutMs: 1_000,
    })

    await expect(broker.create()).rejects.toMatchObject({
      code: 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_CREATE_UNRESOLVED',
    })
    expect(engine.wire.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(engine.getConnections()).toBe(1)
    expect(setup.ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
  })

  it('consumes a genuine permit before rejecting a forged seal and sends no POST', async () => {
    const engine = await engineFixture()
    const setup = await genuineSeal(engine)
    const prepared = await prepareNodeDockerEnginePinnedContainerCreate({
      socketPath: engine.socketPath,
      endpointIdentity: identity(engine.socketPath),
      expectedRuntimeEvidence: setup.runtimeEvidence,
    })
    const operation = setup.activeEpoch.prepare({
      version: 2,
      sidecarKind: 'lease-bound-docker-bash',
      policyHash: '4'.repeat(64),
      resources: [{
        version: 2,
        role: 'worker',
        resourceKind: 'container',
        createProjectionContract: 'container-selected-v2',
        createProjectionHash: '5'.repeat(64),
      }],
    })
    engine.resetMetrics()
    let transportFailure: unknown

    await expect(operation.create('worker', async (_descriptor, permit) => {
      try {
        await prepared.createAndInspect({
          seal: { ...setup.seal } as never,
          permit,
          platform: 'linux/arm64',
          bodyJson: minimalBody(),
        })
      } catch (error) {
        transportFailure = error
      }
      return { kind: 'create-ambiguous' as const }
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })

    expect(transportFailure).toMatchObject({ code: 'DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID' })
    expect(engine.wire.filter(call => call.method === 'POST')).toHaveLength(0)
    expect(setup.ledger.listOperations()[1]!.resources[0]!.phase).toBe('attempted')
  })

  it('rejects a forged permit and oversized body before any POST and burns the transport', async () => {
    const engine = await engineFixture()
    const setup = await genuineSeal(engine)
    let prepared = await prepareNodeDockerEnginePinnedContainerCreate({
      socketPath: engine.socketPath,
      endpointIdentity: identity(engine.socketPath),
      expectedRuntimeEvidence: setup.runtimeEvidence,
    })
    engine.resetMetrics()

    await expect(prepared.createAndInspect({
      seal: setup.seal,
      permit: { version: 1, operationBindingHash: '6'.repeat(64), role: 'worker' } as never,
      platform: 'linux/arm64',
      bodyJson: minimalBody(),
    })).rejects.toMatchObject({ code: 'DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID' })
    expect(engine.wire.filter(call => call.method === 'POST')).toHaveLength(0)
    await expect(prepared.createAndInspect({} as never)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PREPARED_CREATE_ALREADY_USED',
    })

    prepared = await prepareNodeDockerEnginePinnedContainerCreate({
      socketPath: engine.socketPath,
      endpointIdentity: identity(engine.socketPath),
      expectedRuntimeEvidence: setup.runtimeEvidence,
      maxRequestBytes: 512,
    })
    engine.resetMetrics()
    await expect(prepared.createAndInspect({
      seal: setup.seal,
      permit: {} as never,
      platform: 'linux/arm64',
      bodyJson: { Image: IMAGE_REFERENCE, oversized: 'x'.repeat(513) },
    })).rejects.toMatchObject({ code: 'DOCKER_ENGINE_PREPARED_CREATE_INPUT_INVALID' })
    expect(engine.wire.filter(call => call.method === 'POST')).toHaveLength(0)
  })

  it('keeps the factory abort signal authoritative after preflight', async () => {
    const engine = await engineFixture()
    const setup = await genuineSeal(engine)
    const controller = new AbortController()
    const prepared = await prepareNodeDockerEnginePinnedContainerCreate({
      socketPath: engine.socketPath,
      endpointIdentity: identity(engine.socketPath),
      expectedRuntimeEvidence: setup.runtimeEvidence,
      signal: controller.signal,
    })
    engine.resetMetrics()
    controller.abort()

    await expect(prepared.createAndInspect({
      seal: setup.seal,
      permit: {} as never,
      platform: 'linux/arm64',
      bodyJson: minimalBody(),
    })).rejects.toMatchObject({ code: 'DOCKER_ENGINE_PREPARED_CREATE_ABORTED' })
    expect(engine.wire.filter(call => call.method === 'POST')).toHaveLength(0)
  })

  it('loads the accepted ESM cycle in either import order without top-level calls', async () => {
    vi.resetModules()
    const pinnedFirst = await import('./docker-engine-pinned-session.js')
    const planSecond = await import('./docker-code-owned-container-create-plan.js')
    expect(pinnedFirst.prepareNodeDockerEnginePinnedContainerCreate).toBeTypeOf('function')
    expect(planSecond.dockerCodeOwnedContainerCreateSealMatchesWireRequest).toBeTypeOf('function')

    vi.resetModules()
    const planFirst = await import('./docker-code-owned-container-create-plan.js')
    const pinnedSecond = await import('./docker-engine-pinned-session.js')
    expect(planFirst.dockerCodeOwnedContainerCreateSealMatchesObservedResource).toBeTypeOf('function')
    expect(pinnedSecond.isDockerEnginePinnedPreparedContainerCreate).toBeTypeOf('function')
  })

  it('brands prepared transports against structural copies', async () => {
    const engine = await engineFixture()
    const setup = await liveEvidence(engine.socketPath)
    const prepared = await prepareNodeDockerEnginePinnedContainerCreate({
      socketPath: engine.socketPath,
      endpointIdentity: identity(engine.socketPath),
      expectedRuntimeEvidence: setup.runtimeEvidence,
    })
    expect(isDockerEnginePinnedPreparedContainerCreate(prepared)).toBe(true)
    expect(isDockerEnginePinnedPreparedContainerCreate({ ...prepared })).toBe(false)
    await prepared.close()
  })
})

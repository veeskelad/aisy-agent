import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createLeaseBoundDockerBashContainerCreatePlan,
  createWhisperDockerContainerCreatePlan,
  dockerCodeOwnedContainerCreatePlanSelectedProjectionMatchesInspect,
  DockerCodeOwnedContainerCreatePlanError,
  isDockerCodeOwnedContainerCreatePlan,
  isDockerCodeOwnedContainerCreateSeal,
  isNodeDockerCodeOwnedContainerCreateBroker,
  makeNodeDockerCodeOwnedContainerCreateBroker,
  NodeDockerCodeOwnedContainerCreateBrokerError,
  sealDockerCodeOwnedContainerCreatePlan,
} from './docker-code-owned-container-create-plan.js'
import {
  DOCKER_CONTAINER_REQUIRED_MASKED_PATHS_V2,
  DOCKER_CONTAINER_REQUIRED_READONLY_PATHS_V2,
} from './docker-container-selected-projection.js'
import {
  computeDockerEngineUnixSocketBindingHash,
  isDockerEnginePinnedSandboxRuntimeEvidence,
  makeNodeDockerEnginePinnedSession,
  makeNodeOwnedDockerEngineRecoveryBroker,
  type DockerEnginePinnedEndpointIdentityV1,
  type DockerEnginePinnedSandboxRuntimeEvidenceV1,
} from './docker-engine-pinned-session.js'
import {
  createDockerImageRuntimeManifest,
  type DockerImageRuntimeManifestV1,
} from './docker-image-runtime-manifest.js'
import {
  inspectNodeDockerSidecarFilesystemEvidence,
  isDockerSidecarFilesystemEvidence,
  matchesCurrentNodeDockerSidecarFilesystemEvidence,
} from './docker-sidecar-filesystem-evidence.js'
import {
  makeLeaseBoundDockerBashSemanticPlan,
  makeWhisperDockerSemanticPlan,
} from './whisper-bash-docker-semantic-plans.js'
import {
  initializeOwnedDockerResourceLedger,
  openActivatedOwnedDockerResourceLedger,
  reconcileOwnedDockerResources,
  type OwnedDockerActiveEpoch,
  type OwnedDockerAttestedCommandPort,
  type OwnedDockerEndpointIdentityV1,
  type OwnedDockerRecoveryLedger,
  type OwnedDockerResourceKind,
} from './execution-owned-docker-resources.js'

const SERVER_ID = 'docker-engine-primary'
const SERVER_VERSION = '29.5.2'
const IMAGE_ID = `sha256:${'d'.repeat(64)}`
const IMAGE_REFERENCE = `registry.example/aisy/worker@sha256:${'c'.repeat(64)}`
const TMPFS = 'rw,nosuid,nodev,noexec,size=67108864,mode=0700'
const cleanups: Array<() => Promise<void> | void> = []
const activationSocketPaths = new Map<string, string>()

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function identity(socketPath: string): DockerEnginePinnedEndpointIdentityV1 {
  return {
    version: 1,
    endpointBindingHash: computeDockerEngineUnixSocketBindingHash(socketPath),
    serverId: SERVER_ID,
    serverVersion: SERVER_VERSION,
    apiVersion: '1.54',
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

async function manifestFor(
  configOverride: Record<string, unknown> = {},
  runtime: 'runc' | 'runsc' = 'runsc',
): Promise<Readonly<{
  manifest: DockerImageRuntimeManifestV1
  runtimeEvidence: DockerEnginePinnedSandboxRuntimeEvidenceV1
}>> {
  const socketRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'aisy-create-plan-engine-')))
  const socketPath = join(socketRoot, 'engine.sock')
  const document = imageDocument()
  ;(document['Config'] as Record<string, unknown>) = {
    ...(document['Config'] as Record<string, unknown>),
    ...configOverride,
  }
  const server = createServer((request, response) => {
    if (request.url === '/v1.54/version') {
      return json(response, { Version: SERVER_VERSION, ApiVersion: '1.55', MinAPIVersion: '1.40' })
    }
    if (request.url === '/v1.54/info') return json(response, {
      ID: SERVER_ID,
      ServerVersion: SERVER_VERSION,
      SecurityOptions: ['name=seccomp,profile=builtin', 'name=userns'],
      Runtimes: runtime === 'runsc' ? { runc: {}, runsc: {} } : { runc: {} },
    })
    if (request.url?.includes('/containers/json?') || request.url?.includes('/networks?')) {
      return json(response, [])
    }
    return json(response, document)
  })
  await listen(server, socketPath)
  activationSocketPaths.set(identity(socketPath).endpointBindingHash, socketPath)
  cleanups.push(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(socketRoot, { recursive: true, force: true })
  })
  const runtimeSession = makeNodeDockerEnginePinnedSession({
    socketPath,
    endpointIdentity: identity(socketPath),
    timeoutMs: 1_000,
  })
  const imageSession = makeNodeDockerEnginePinnedSession({
    socketPath,
    endpointIdentity: identity(socketPath),
    timeoutMs: 1_000,
  })
  try {
    const runtimeEvidence = await runtimeSession.attestSandboxRuntime()
    const result = await imageSession.inspectImageRuntime(IMAGE_REFERENCE)
    if (result.outcome !== 'found') throw new Error('expected image evidence')
    return Object.freeze({
      manifest: createDockerImageRuntimeManifest(result.evidence),
      runtimeEvidence,
    })
  } finally {
    await runtimeSession.close()
    await imageSession.close()
  }
}

async function liveEvidence(socketPath: string): Promise<Readonly<{
  manifest: DockerImageRuntimeManifestV1
  runtimeEvidence: DockerEnginePinnedSandboxRuntimeEvidenceV1
}>> {
  const runtimeSession = makeNodeDockerEnginePinnedSession({
    socketPath, endpointIdentity: identity(socketPath), timeoutMs: 1_000,
  })
  const imageSession = makeNodeDockerEnginePinnedSession({
    socketPath, endpointIdentity: identity(socketPath), timeoutMs: 1_000,
  })
  try {
    const runtimeEvidence = await runtimeSession.attestSandboxRuntime()
    const inspected = await imageSession.inspectImageRuntime(IMAGE_REFERENCE)
    if (inspected.outcome !== 'found') throw new Error('expected image evidence')
    return Object.freeze({
      manifest: createDockerImageRuntimeManifest(inspected.evidence),
      runtimeEvidence,
    })
  } finally {
    await runtimeSession.close()
    await imageSession.close()
  }
}

type BrokerEngineMode = 'success' | 'lost-201' | 'not-found' | 'conflict'

async function brokerEngine(mode: BrokerEngineMode = 'success'): Promise<Readonly<{
  socketPath: string
  wire: Array<Readonly<{ method: string | undefined; url: string | undefined }>>
  sockets: Set<Socket>
  getConnections(): number
  getPostedBody(): Record<string, unknown> | null
  setRuntimeDrift(): void
}>> {
  const engineRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'aisy-create-broker-engine-')))
  const socketPath = join(engineRoot, 'engine.sock')
  const wire: Array<Readonly<{ method: string | undefined; url: string | undefined }>> = []
  const sockets = new Set<Socket>()
  let connections = 0
  let runtimeDrift = false
  let postedBody: Record<string, unknown> | null = null
  const createdId = '9'.repeat(64)
  const encode = (value: unknown): string => {
    if (value === null) return 'null'
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return JSON.stringify(value)
    }
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`
  }
  const respond = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(encode(value))
  }
  const inspectDocument = (name: string): Record<string, unknown> => {
    if (postedBody === null) throw new Error('create body is missing')
    const config = { ...postedBody }
    const requestHost = config['HostConfig'] as Record<string, unknown>
    delete config['HostConfig']
    const hostConfig = { ...requestHost }
    const requestMounts = hostConfig['Mounts'] as Array<Record<string, unknown>>
    delete hostConfig['Mounts']
    return {
      Id: createdId,
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
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    wire.push({ method: request.method, url: request.url })
    sockets.add(request.socket)
    if (request.url === '/v1.54/version') {
      return respond(response, 200, {
        Version: SERVER_VERSION, ApiVersion: '1.55', MinAPIVersion: '1.40',
      })
    }
    if (request.url === '/v1.54/info') {
      return respond(response, 200, {
        ID: SERVER_ID,
        ServerVersion: SERVER_VERSION,
        SecurityOptions: runtimeDrift
          ? ['name=seccomp,profile=builtin', 'name=rootless']
          : ['name=seccomp,profile=builtin', 'name=userns'],
        Runtimes: runtimeDrift ? { runc: {} } : { runc: {}, runsc: {} },
      })
    }
    if (request.url?.includes('/containers/json?') || request.url?.includes('/networks?')) {
      return respond(response, 200, [])
    }
    if (request.url?.startsWith('/v1.54/images/')) return respond(response, 200, imageDocument())
    if (request.method === 'POST' && request.url?.startsWith('/v1.54/containers/create?')) {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      request.on('end', () => {
        postedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        if (mode === 'lost-201') {
          request.socket.destroy()
          return
        }
        if (mode === 'not-found') return respond(response, 404, { message: 'private ignored' })
        if (mode === 'conflict') return respond(response, 409, { message: 'private ignored' })
        respond(response, 201, { Id: createdId, Warnings: null })
      })
      return
    }
    const match = request.url?.match(/^\/v1\.54\/containers\/([a-f0-9]{64})\/json$/)
    if (match !== null && match !== undefined) {
      const name = new URL(
        wire.find(item => item.method === 'POST')!.url!,
        'http://docker.invalid',
      ).searchParams.get('name')!
      return respond(response, 200, inspectDocument(name))
    }
    respond(response, 500, {})
  })
  server.on('connection', () => { connections += 1 })
  await listen(server, socketPath)
  activationSocketPaths.set(identity(socketPath).endpointBindingHash, socketPath)
  cleanups.push(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(engineRoot, { recursive: true, force: true })
  })
  return Object.freeze({
    socketPath,
    wire,
    sockets,
    getConnections: () => connections,
    getPostedBody: () => postedBody,
    setRuntimeDrift: () => { runtimeDrift = true },
  })
}

function root(name: string): string {
  const value = realpathSync.native(mkdtempSync(join(tmpdir(), `aisy-${name}-`)))
  cleanups.push(() => rmSync(value, { recursive: true, force: true }))
  return value
}

async function activeFor(
  endpointIdentity: OwnedDockerEndpointIdentityV1,
): Promise<Readonly<{
  ledger: OwnedDockerRecoveryLedger
  activeEpoch: OwnedDockerActiveEpoch
  docker: OwnedDockerAttestedCommandPort
}>> {
  const base = mkdtempSync(join(tmpdir(), 'aisy-create-seal-ledger-'))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const ledgerRoot = join(base, 'ledger')
  const activation = initializeOwnedDockerResourceLedger({
    root: ledgerRoot,
    installationId: 'a'.repeat(64),
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
  const activated = await activateLedger(ledger, docker, endpointIdentity)
  return Object.freeze({ ledger, activeEpoch: activated.activeEpoch, docker })
}

async function activateLedger(
  ledger: OwnedDockerRecoveryLedger,
  docker: OwnedDockerAttestedCommandPort,
  endpointIdentity: OwnedDockerEndpointIdentityV1,
) {
  const socketPath = activationSocketPaths.get(endpointIdentity.endpointBindingHash)
  if (socketPath === undefined) throw new Error('missing genuine activation endpoint')
  const recovery = makeNodeOwnedDockerEngineRecoveryBroker({
    socketPath,
    endpointIdentity: endpointIdentity as DockerEnginePinnedEndpointIdentityV1,
    authority: ledger,
    timeoutMs: 1_000,
  })
  return ledger.activateAfterInstallationZero(docker, recovery)
}

async function brokerHarness(
  kind: 'lease-bound-docker-bash' | 'whisper',
  mode: BrokerEngineMode = 'success',
) {
  const engine = await brokerEngine(mode)
  const { manifest, runtimeEvidence } = await liveEvidence(engine.socketPath)
  const privateRoot = root(kind === 'whisper' ? 'broker-whisper' : 'broker-bash')
  const secret = kind === 'whisper' ? 'voice/private.ogg' : 'printf private-broker-command'
  const filesystem = kind === 'whisper'
    ? inspectNodeDockerSidecarFilesystemEvidence({
      kind: 'whisper-input', root: privateRoot, relativeName: secret,
    })
    : inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: privateRoot })
  const plan = kind === 'whisper'
    ? createWhisperDockerContainerCreatePlan({
      semanticDraft: whisperDraft(filesystem.rootIdentityHash, filesystem.relativeNameHash!),
      imageManifest: manifest,
      filesystem,
      runtimeEvidence,
    })
    : createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(
        filesystem.rootIdentityHash, secret, runtimeEvidence.isolationProfileSha256,
      ),
      imageManifest: manifest,
      filesystem,
      command: secret,
      runtimeEvidence,
    })
  const active = await activeFor(plan.endpointIdentity)
  const seal = sealDockerCodeOwnedContainerCreatePlan({ plan, activeEpoch: active.activeEpoch })
  const resourceName = active.ledger.listOperations()[0]!.resources[0]!.name
  engine.wire.length = 0
  engine.sockets.clear()
  const connectionsBefore = engine.getConnections()
  const broker = makeNodeDockerCodeOwnedContainerCreateBroker({
    seal, socketPath: engine.socketPath, timeoutMs: 1_000,
  })
  return Object.freeze({
    engine, active, plan, seal, broker, privateRoot, secret, resourceName, connectionsBefore,
  })
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
  activationSocketPaths.clear()
})

function bashDraft(rootIdentityHash: string, command: string, isolationProfileSha256: string) {
  return makeLeaseBoundDockerBashSemanticPlan({
    leaseBindingHash: '1'.repeat(64),
    operationBindingHash: '2'.repeat(64),
    workspaceIdentityHash: rootIdentityHash,
    instructionSha256: createHash('sha256').update(command).digest('hex'),
    instructionBytes: Buffer.byteLength(command, 'utf8'),
    isolationProfileSha256,
    limits: {
      memoryBytes: 512 * 1024 * 1024,
      cpuMillicores: 1_000,
      pids: 128,
      wallTimeMs: 120_000,
      maximumOutputBytes: 1024 * 1024,
    },
  })
}

function whisperDraft(rootIdentityHash: string, relativeNameHash: string) {
  return makeWhisperDockerSemanticPlan({
    requestBindingHash: '4'.repeat(64),
    inputRootIdentityHash: rootIdentityHash,
    inputRelativeNameHash: relativeNameHash,
    audioSha256: '5'.repeat(64),
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
  })
}

function ownership(kind: 'whisper' | 'lease-bound-docker-bash'): Record<string, string> {
  return {
    'com.aisy.resource.version': '1',
    'com.aisy.resource.installation': '1'.repeat(64),
    'com.aisy.resource.owner': '2'.repeat(64),
    'com.aisy.resource.session': '3'.repeat(64),
    'com.aisy.resource.operation': '4'.repeat(64),
    'com.aisy.resource.kind': kind,
    'com.aisy.resource.role': 'worker',
    'com.aisy.resource.policy': '5'.repeat(64),
  }
}

function bashInspect(workspace: string, command: string): Record<string, unknown> {
  return {
    Image: IMAGE_ID,
    Config: {
      Image: IMAGE_REFERENCE,
      User: '65532:65532',
      Env: ['LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'PATH=/usr/bin'],
      Entrypoint: ['/bin/sh'],
      Cmd: ['-lc', command],
      WorkingDir: '/work',
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
      Labels: { ...ownership('lease-bound-docker-bash'), 'org.opencontainers.image.title': 'aisy-worker' },
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
      LogConfig: { Type: 'local', Config: { 'max-size': '1048576', 'max-file': '1', compress: 'false' } },
      Tmpfs: { '/tmp': TMPFS }, Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
      Devices: [], DeviceRequests: [], PortBindings: {}, PublishAllPorts: false,
      OomKillDisable: false, OomScoreAdj: 0, ShmSize: 64 * 1024 * 1024, Init: false,
    },
    Mounts: [{ Type: 'bind', Source: workspace, Destination: '/work', RW: true, Propagation: 'rprivate' }],
  }
}

function expectPlanInvalid(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({
    name: 'DockerCodeOwnedContainerCreatePlanError',
    code: 'DOCKER_CODE_OWNED_CONTAINER_CREATE_PLAN_INVALID',
  } satisfies Partial<DockerCodeOwnedContainerCreatePlanError>))
}

function expectSealInvalid(action: () => unknown): void {
  expectPlanInvalid(action)
}

describe('genuine Docker container create-plan evidence', () => {
  it('binds Bash draft, pinned image and current root without exposing command or path', async () => {
    const workspace = root('bash-plan')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    const { manifest, runtimeEvidence } = await manifestFor()
    const selectedCommand = 'printf sensitive-command'
    const draft = bashDraft(
      filesystem.rootIdentityHash, selectedCommand, runtimeEvidence.isolationProfileSha256,
    )

    const first = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: draft, imageManifest: manifest, filesystem,
      command: selectedCommand, runtimeEvidence,
    })
    const second = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: draft, imageManifest: manifest, filesystem,
      command: selectedCommand, runtimeEvidence,
    })

    expect(first).toMatchObject({
      version: 1,
      kind: 'aisy-docker-container-create-plan-v1',
      sidecarKind: 'lease-bound-docker-bash',
      role: 'worker',
      semanticDraftHash: draft.semanticDraftHash,
      imageManifestHash: manifest.manifestHash,
      imageReference: IMAGE_REFERENCE,
      imageId: IMAGE_ID,
      runtime: 'runsc',
      securityLevel: 'full',
      isolationProfileSha256: runtimeEvidence.isolationProfileSha256,
      runtimeEvidenceHash: runtimeEvidence.runtimeEvidenceHash,
    })
    expect(first.createPlanHash).toBe(second.createPlanHash)
    expect(first.selectedProjectionHash).toBe(second.selectedProjectionHash)
    expect(isDockerCodeOwnedContainerCreatePlan(first)).toBe(true)
    expect(isDockerCodeOwnedContainerCreatePlan({ ...first })).toBe(false)
    expect(JSON.stringify(first)).not.toContain(workspace)
    expect(JSON.stringify(first)).not.toContain(selectedCommand)
    expect(dockerCodeOwnedContainerCreatePlanSelectedProjectionMatchesInspect(
      first, bashInspect(workspace, selectedCommand),
    )).toBe(true)
  })

  it('creates a distinct genuine Whisper plan from image ABI and private filesystem evidence', async () => {
    const inputRoot = root('whisper-plan')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({
      kind: 'whisper-input', root: inputRoot, relativeName: 'voice/input.ogg',
    })
    const { manifest, runtimeEvidence } = await manifestFor()
    const draft = whisperDraft(filesystem.rootIdentityHash, filesystem.relativeNameHash!)

    const plan = createWhisperDockerContainerCreatePlan({
      semanticDraft: draft, imageManifest: manifest, filesystem, runtimeEvidence,
    })

    expect(plan.sidecarKind).toBe('whisper')
    expect(plan.semanticDraftHash).toBe(draft.semanticDraftHash)
    expect(plan.endpointIdentity).toBe(manifest.endpointIdentity)
    expect(plan.createPlanHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(plan)).not.toContain(inputRoot)
    expect(JSON.stringify(plan)).not.toContain('voice/input.ogg')
  })

  it('fails closed for command, root and image-runtime mismatches', async () => {
    const workspace = root('mismatch')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    const { manifest, runtimeEvidence } = await manifestFor()
    const draft = bashDraft(
      filesystem.rootIdentityHash, 'printf expected', runtimeEvidence.isolationProfileSha256,
    )

    expectPlanInvalid(() => createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: draft, imageManifest: manifest, filesystem,
      command: 'printf changed', runtimeEvidence,
    }))
    expectPlanInvalid(() => createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: draft, imageManifest: manifest, filesystem,
      command: 'printf expected', runtimeEvidence: { ...runtimeEvidence, runtime: 'runc' },
    }))

    const other = root('other')
    const otherFilesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: other })
    expectPlanInvalid(() => createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: draft, imageManifest: manifest, filesystem: otherFilesystem,
      command: 'printf expected', runtimeEvidence,
    }))

    const {
      manifest: volumeManifest,
      runtimeEvidence: volumeRuntimeEvidence,
    } = await manifestFor({ Volumes: { '/unexpected': {} } })
    expectPlanInvalid(() => createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(
        filesystem.rootIdentityHash,
        'printf expected',
        volumeRuntimeEvidence.isolationProfileSha256,
      ),
      imageManifest: volumeManifest,
      filesystem,
      command: 'printf expected',
      runtimeEvidence: volumeRuntimeEvidence,
    }))
  })

  it('binds runtime to genuine endpoint evidence and makes a downgrade explicit', async () => {
    const workspace = root('runtime-binding')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    const command = 'printf isolated'
    const full = await manifestFor()
    const degraded = await manifestFor({}, 'runc')
    const fullDraft = bashDraft(
      filesystem.rootIdentityHash, command, full.runtimeEvidence.isolationProfileSha256,
    )

    expect(isDockerEnginePinnedSandboxRuntimeEvidence(full.runtimeEvidence)).toBe(true)
    expectPlanInvalid(() => createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: fullDraft,
      imageManifest: full.manifest,
      filesystem,
      command,
      runtimeEvidence: { ...full.runtimeEvidence, runtime: 'runc' },
    }))
    expectPlanInvalid(() => createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: fullDraft,
      imageManifest: full.manifest,
      filesystem,
      command,
      runtimeEvidence: degraded.runtimeEvidence,
    }))
    expectPlanInvalid(() => createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: fullDraft,
      imageManifest: degraded.manifest,
      filesystem,
      command,
      runtimeEvidence: degraded.runtimeEvidence,
    }))

    const degradedDraft = bashDraft(
      filesystem.rootIdentityHash, command, degraded.runtimeEvidence.isolationProfileSha256,
    )
    const degradedPlan = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: degradedDraft,
      imageManifest: degraded.manifest,
      filesystem,
      command,
      runtimeEvidence: degraded.runtimeEvidence,
    })
    expect(degradedPlan).toMatchObject({
      runtime: 'runc',
      securityLevel: 'degraded-no-gvisor',
      isolationProfileSha256: degraded.runtimeEvidence.isolationProfileSha256,
      runtimeEvidenceHash: degraded.runtimeEvidence.runtimeEvidenceHash,
    })
    expect(degradedPlan.createPlanHash).not.toBe(createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: fullDraft,
      imageManifest: full.manifest,
      filesystem,
      command,
      runtimeEvidence: full.runtimeEvidence,
    }).createPlanHash)
  })

  it('detects root replacement before inspect parity can succeed', async () => {
    const workspace = root('replacement')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    const { manifest, runtimeEvidence } = await manifestFor()
    const selectedCommand = 'printf safe'
    const plan = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(
        filesystem.rootIdentityHash, selectedCommand, runtimeEvidence.isolationProfileSha256,
      ),
      imageManifest: manifest, filesystem, command: selectedCommand, runtimeEvidence,
    })
    const priorWorkspace = `${workspace}-old`
    renameSync(workspace, priorWorkspace)
    cleanups.push(() => rmSync(priorWorkspace, { recursive: true, force: true }))
    mkdirSync(workspace)

    expect(matchesCurrentNodeDockerSidecarFilesystemEvidence(filesystem)).toBe(false)
    expect(dockerCodeOwnedContainerCreatePlanSelectedProjectionMatchesInspect(
      plan, bashInspect(workspace, selectedCommand),
    )).toBe(false)
  })

  it('rejects forged filesystem evidence, symlinks and hostile descriptors without callbacks', () => {
    const workspace = root('evidence')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    expect(isDockerSidecarFilesystemEvidence(filesystem)).toBe(true)
    expect(isDockerSidecarFilesystemEvidence({ ...filesystem })).toBe(false)

    const link = `${workspace}-link`
    symlinkSync(workspace, link)
    cleanups.push(() => unlinkSync(link))
    expect(() => inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: link }))
      .toThrowError(expect.objectContaining({ code: 'DOCKER_SIDECAR_FILESYSTEM_EVIDENCE_INVALID' }))

    let calls = 0
    const hostile = { kind: 'bash-workspace', root: workspace }
    Object.defineProperty(hostile, 'root', {
      enumerable: true,
      get() { calls += 1; return workspace },
    })
    expect(() => inspectNodeDockerSidecarFilesystemEvidence(hostile as never))
      .toThrowError(expect.objectContaining({ code: 'DOCKER_SIDECAR_FILESYSTEM_EVIDENCE_INVALID' }))
    expect(calls).toBe(0)
  })

  it('forbids inherited com.aisy labels before a create plan can exist', async () => {
    await expect(manifestFor({ Labels: { 'com.aisy.injected': 'foreign' } }))
      .rejects.toMatchObject({ code: 'DOCKER_IMAGE_RUNTIME_MANIFEST_INVALID' })
  })
})

describe('prepared one-shot Docker container create seal', () => {
  it('publishes and seals one exact Bash worker intent without exposing request data', async () => {
    const workspace = root('bash-seal')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    const { manifest, runtimeEvidence } = await manifestFor()
    const selectedCommand = 'printf private-sealed-command'
    const plan = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(
        filesystem.rootIdentityHash, selectedCommand, runtimeEvidence.isolationProfileSha256,
      ),
      imageManifest: manifest,
      filesystem,
      command: selectedCommand,
      runtimeEvidence,
    })
    const { ledger, activeEpoch } = await activeFor(plan.endpointIdentity)

    const seal = sealDockerCodeOwnedContainerCreatePlan({ plan, activeEpoch })
    const operation = ledger.listOperations()[0]!
    const resource = operation.resources[0]!

    expect(seal).toMatchObject({
      version: 1,
      kind: 'aisy-docker-container-create-seal-v1',
      sidecarKind: 'lease-bound-docker-bash',
      role: 'worker',
      createPlanHash: plan.createPlanHash,
      selectedProjectionHash: plan.selectedProjectionHash,
      sealedRequestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(operation).toMatchObject({
      sidecarKind: 'lease-bound-docker-bash',
      policyHash: plan.createPlanHash,
    })
    expect(operation.resources).toHaveLength(1)
    expect(resource).toMatchObject({
      role: 'worker',
      resourceKind: 'container',
      createProjectionContract: 'container-selected-v2',
      createProjectionHash: plan.selectedProjectionHash,
      phase: 'prepared',
      objectId: null,
      boundProjectionHashV1: null,
    })
    expect(isDockerCodeOwnedContainerCreateSeal(seal)).toBe(true)
    expect(isDockerCodeOwnedContainerCreateSeal({ ...seal })).toBe(false)
    expect(isDockerCodeOwnedContainerCreateSeal(new Proxy(seal, {}))).toBe(false)
    expect(Object.isFrozen(seal)).toBe(true)
    expect(Object.keys(seal).sort()).toEqual([
      'createPlanHash', 'kind', 'role', 'sealedRequestHash', 'selectedProjectionHash',
      'sidecarKind', 'version',
    ])
    const publicJson = JSON.stringify(seal)
    expect(publicJson).not.toContain(workspace)
    expect(publicJson).not.toContain(selectedCommand)
    expect(publicJson).not.toContain(resource.name)
    expect(publicJson).not.toContain(operation.operationBindingHash)
    expect(seal.sealedRequestHash).not.toBe(plan.createRequestTemplateHash)
  })

  it('publishes the same exact prepared contract for a Whisper worker', async () => {
    const inputRoot = root('whisper-seal')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({
      kind: 'whisper-input', root: inputRoot, relativeName: 'voice/private.ogg',
    })
    const { manifest, runtimeEvidence } = await manifestFor()
    const plan = createWhisperDockerContainerCreatePlan({
      semanticDraft: whisperDraft(filesystem.rootIdentityHash, filesystem.relativeNameHash!),
      imageManifest: manifest,
      filesystem,
      runtimeEvidence,
    })
    const { ledger, activeEpoch } = await activeFor(plan.endpointIdentity)

    const seal = sealDockerCodeOwnedContainerCreatePlan({ plan, activeEpoch })

    expect(seal.sidecarKind).toBe('whisper')
    expect(ledger.listOperations()).toMatchObject([{
      sidecarKind: 'whisper',
      policyHash: plan.createPlanHash,
      resources: [{
        role: 'worker',
        resourceKind: 'container',
        createProjectionContract: 'container-selected-v2',
        createProjectionHash: plan.selectedProjectionHash,
        phase: 'prepared',
      }],
    }])
    expect(JSON.stringify(seal)).not.toContain(inputRoot)
    expect(JSON.stringify(seal)).not.toContain('voice/private.ogg')
  })

  it('does not let inherited array toJSON influence the sealed request hash', async () => {
    const workspace = root('seal-to-json')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    const { manifest, runtimeEvidence } = await manifestFor()
    const command = 'printf canonical'
    const plan = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(filesystem.rootIdentityHash, command, runtimeEvidence.isolationProfileSha256),
      imageManifest: manifest, filesystem, command, runtimeEvidence,
    })
    const { activeEpoch } = await activeFor(plan.endpointIdentity)
    const prior = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
    let calls = 0
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value() { calls += 1; return { collapsed: true } },
    })
    try {
      const seal = sealDockerCodeOwnedContainerCreatePlan({ plan, activeEpoch })
      expect(seal.sealedRequestHash).toMatch(/^[a-f0-9]{64}$/)
      expect(calls).toBe(0)
    } finally {
      if (prior === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON
      else Object.defineProperty(Array.prototype, 'toJSON', prior)
    }
  })

  it('burns a genuine plan before allocation and never allocates twice on replay', async () => {
    const workspace = root('seal-replay')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    const { manifest, runtimeEvidence } = await manifestFor()
    const command = 'printf once'
    const plan = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(filesystem.rootIdentityHash, command, runtimeEvidence.isolationProfileSha256),
      imageManifest: manifest, filesystem, command, runtimeEvidence,
    })
    const { ledger, activeEpoch } = await activeFor(plan.endpointIdentity)

    sealDockerCodeOwnedContainerCreatePlan({ plan, activeEpoch })
    expectSealInvalid(() => sealDockerCodeOwnedContainerCreatePlan({ plan, activeEpoch }))

    expect(ledger.listOperations()).toHaveLength(1)
    expect(ledger.listOperations()[0]!.operationSequence).toBe(1)
  })

  it('binds the sealed hash to ledger-owned names and ownership labels', async () => {
    const workspace = root('seal-ledger-binding')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    const { manifest, runtimeEvidence } = await manifestFor()
    const command = 'printf ledger-bound'
    const makePlan = () => createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(filesystem.rootIdentityHash, command, runtimeEvidence.isolationProfileSha256),
      imageManifest: manifest, filesystem, command, runtimeEvidence,
    })
    const firstPlan = makePlan()
    const secondPlan = makePlan()
    const { ledger, activeEpoch } = await activeFor(firstPlan.endpointIdentity)

    const first = sealDockerCodeOwnedContainerCreatePlan({ plan: firstPlan, activeEpoch })
    const second = sealDockerCodeOwnedContainerCreatePlan({ plan: secondPlan, activeEpoch })

    expect(firstPlan.createPlanHash).toBe(secondPlan.createPlanHash)
    expect(first.selectedProjectionHash).toBe(second.selectedProjectionHash)
    expect(first.sealedRequestHash).not.toBe(second.sealedRequestHash)
    expect(ledger.listOperations()).toHaveLength(2)
    expect(ledger.listOperations()[0]!.resources[0]!.name)
      .not.toBe(ledger.listOperations()[1]!.resources[0]!.name)
  })

  it('rejects forged values and hostile input descriptors before sequence allocation', async () => {
    const workspace = root('seal-hostile')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    const { manifest, runtimeEvidence } = await manifestFor()
    const command = 'printf guarded'
    const plan = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(filesystem.rootIdentityHash, command, runtimeEvidence.isolationProfileSha256),
      imageManifest: manifest, filesystem, command, runtimeEvidence,
    })
    const { ledger, activeEpoch } = await activeFor(plan.endpointIdentity)

    expectSealInvalid(() => sealDockerCodeOwnedContainerCreatePlan({
      plan: { ...plan }, activeEpoch,
    } as never))
    expectSealInvalid(() => sealDockerCodeOwnedContainerCreatePlan({
      plan: new Proxy(plan, {}), activeEpoch,
    }))
    expectSealInvalid(() => sealDockerCodeOwnedContainerCreatePlan({
      plan, activeEpoch: { ...activeEpoch },
    } as never))
    expectSealInvalid(() => sealDockerCodeOwnedContainerCreatePlan({
      plan, activeEpoch: new Proxy(activeEpoch, {}),
    }))

    let getterCalls = 0
    const accessor: Record<string, unknown> = { activeEpoch }
    Object.defineProperty(accessor, 'plan', {
      enumerable: true,
      get() { getterCalls += 1; return plan },
    })
    let proxyTrapCalls = 0
    const proxy = new Proxy({ plan, activeEpoch }, {
      ownKeys() { proxyTrapCalls += 1; return ['plan', 'activeEpoch'] },
    })
    for (const input of [
      accessor,
      proxy,
      { plan, activeEpoch, [Symbol('unexpected')]: true },
      Object.assign(Object.create(null) as Record<string, unknown>, { plan, activeEpoch }),
    ]) {
      expectSealInvalid(() => sealDockerCodeOwnedContainerCreatePlan(input as never))
    }
    expect(getterCalls).toBe(0)
    expect(proxyTrapCalls).toBe(0)
    expect(ledger.listOperations()).toHaveLength(0)

    expect(isDockerCodeOwnedContainerCreateSeal(
      sealDockerCodeOwnedContainerCreatePlan({ plan, activeEpoch }),
    )).toBe(true)
    expect(ledger.listOperations()).toHaveLength(1)
  })

  it('rejects cross-endpoint and stale active epochs before allocation', async () => {
    const workspace = root('seal-authority')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({ kind: 'bash-workspace', root: workspace })
    const { manifest, runtimeEvidence } = await manifestFor()
    const command = 'printf authority'
    const crossPlan = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(filesystem.rootIdentityHash, command, runtimeEvidence.isolationProfileSha256),
      imageManifest: manifest, filesystem, command, runtimeEvidence,
    })
    const valid = await activeFor(crossPlan.endpointIdentity)
    const crossEndpoint = await manifestFor()
    const cross = await activeFor(crossEndpoint.runtimeEvidence.endpointIdentity)

    expectSealInvalid(() => sealDockerCodeOwnedContainerCreatePlan({
      plan: crossPlan,
      activeEpoch: cross.activeEpoch,
    }))
    expect(cross.ledger.listOperations()).toHaveLength(0)
    expect(isDockerCodeOwnedContainerCreateSeal(sealDockerCodeOwnedContainerCreatePlan({
      plan: crossPlan,
      activeEpoch: valid.activeEpoch,
    }))).toBe(true)
    expect(valid.ledger.listOperations()).toHaveLength(1)

    const staleCommand = 'printf stale'
    const stalePlan = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(
        filesystem.rootIdentityHash, staleCommand, runtimeEvidence.isolationProfileSha256,
      ),
      imageManifest: manifest, filesystem, command: staleCommand, runtimeEvidence,
    })
    const staleHarness = await activeFor(stalePlan.endpointIdentity)
    await reconcileOwnedDockerResources({
      ledger: staleHarness.ledger,
      docker: staleHarness.docker,
    })
    const rotated = await activateLedger(
      staleHarness.ledger,
      staleHarness.docker,
      stalePlan.endpointIdentity,
    )
    expectSealInvalid(() => sealDockerCodeOwnedContainerCreatePlan({
      plan: stalePlan,
      activeEpoch: staleHarness.activeEpoch,
    }))
    expect(staleHarness.ledger.listOperations()).toHaveLength(0)
    const freshPlan = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(
        filesystem.rootIdentityHash, staleCommand, runtimeEvidence.isolationProfileSha256,
      ),
      imageManifest: manifest, filesystem, command: staleCommand, runtimeEvidence,
    })
    expect(isDockerCodeOwnedContainerCreateSeal(sealDockerCodeOwnedContainerCreatePlan({
      plan: freshPlan,
      activeEpoch: rotated.activeEpoch,
    }))).toBe(true)
    expect(staleHarness.ledger.listOperations()).toHaveLength(1)
  })
})

describe('code-owned pinned Docker container create broker', () => {
  it('loads the mutually dependent broker and pinned transport modules without an import-cycle failure', async () => {
    const [brokerModule, pinnedModule] = await Promise.all([
      import('./docker-code-owned-container-create-plan.js'),
      import('./docker-engine-pinned-session.js'),
    ])

    expect(typeof brokerModule.makeNodeDockerCodeOwnedContainerCreateBroker).toBe('function')
    expect(typeof pinnedModule.prepareNodeDockerEnginePinnedContainerCreate).toBe('function')
  })

  it.each(['lease-bound-docker-bash', 'whisper'] as const)(
    'creates and binds one %s worker without exposing mutation authority',
    async kind => {
      const harness = await brokerHarness(kind)

      await expect(harness.broker.create()).resolves.toEqual({ kind: 'created-and-bound' })

      expect(harness.engine.wire).toEqual([
        { method: 'GET', url: '/v1.54/version' },
        { method: 'GET', url: '/v1.54/info' },
        {
          method: 'POST',
          url: `/v1.54/containers/create?name=${harness.resourceName}&platform=linux%2Farm64`,
        },
        { method: 'GET', url: `/v1.54/containers/${'9'.repeat(64)}/json` },
      ])
      expect(harness.engine.getConnections() - harness.connectionsBefore).toBe(1)
      expect(harness.engine.sockets.size).toBe(1)
      const operation = harness.active.ledger.listOperations()[0]!
      expect(operation.resources[0]).toMatchObject({
        phase: 'bound',
        objectId: '9'.repeat(64),
        boundProjectionHashV1: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      const body = harness.engine.getPostedBody()!
      const labels = body['Labels'] as Record<string, string>
      expect(labels).toMatchObject({
        'com.aisy.resource.installation': operation.installationId,
        'com.aisy.resource.owner': operation.ownerBindingHash,
        'com.aisy.resource.session': operation.sessionBindingHash,
        'com.aisy.resource.operation': operation.operationBindingHash,
        'com.aisy.resource.kind': kind,
        'com.aisy.resource.role': 'worker',
        'com.aisy.resource.policy': harness.plan.createPlanHash,
      })
      expect(JSON.stringify(harness.seal)).not.toContain(harness.privateRoot)
      expect(JSON.stringify(harness.seal)).not.toContain(harness.secret)
      expect(JSON.stringify(harness.broker)).not.toContain(harness.privateRoot)
      expect(JSON.stringify(harness.broker)).not.toContain(harness.secret)
      expect('use' in harness.broker).toBe(false)
      expect('start' in harness.broker).toBe(false)
      expect('remove' in harness.broker).toBe(false)
    },
  )

  it('leaves the durable intent prepared when pinned runtime preflight drifts', async () => {
    const harness = await brokerHarness('lease-bound-docker-bash')
    harness.engine.setRuntimeDrift()

    await expect(harness.broker.create()).rejects.toMatchObject({
      code: 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_PREFLIGHT_FAILED',
    })

    expect(harness.engine.wire.map(item => item.url)).toEqual(['/v1.54/version', '/v1.54/info'])
    expect(harness.engine.wire.some(item => item.method === 'POST')).toBe(false)
    expect(harness.active.ledger.listOperations()[0]!.resources[0]!.phase).toBe('prepared')
  })

  it.each(['lost-201', 'not-found', 'conflict'] as const)(
    'keeps %s as an attempted unresolved create without retry',
    async mode => {
      const harness = await brokerHarness('lease-bound-docker-bash', mode)

      await expect(harness.broker.create()).rejects.toMatchObject({
        code: 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_CREATE_UNRESOLVED',
      })

      expect(harness.engine.wire.filter(item => item.method === 'POST')).toHaveLength(1)
      expect(harness.engine.getConnections() - harness.connectionsBefore).toBe(1)
      expect(harness.active.ledger.listOperations()[0]!.resources[0]).toMatchObject({
        phase: 'attempted', objectId: null, boundProjectionHashV1: null,
      })
      await expect(harness.broker.create()).rejects.toMatchObject({
        code: 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_ALREADY_USED',
      })
      expect(harness.engine.wire.filter(item => item.method === 'POST')).toHaveLength(1)
    },
  )

  it('admits one concurrent create and keeps the public broker surface redacted', async () => {
    const harness = await brokerHarness('lease-bound-docker-bash')
    const results = await Promise.allSettled([harness.broker.create(), harness.broker.create()])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({
      code: 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_ALREADY_USED',
    })
    expect(harness.engine.wire.filter(item => item.method === 'POST')).toHaveLength(1)
    expect(isNodeDockerCodeOwnedContainerCreateBroker(harness.broker)).toBe(true)
    expect(isNodeDockerCodeOwnedContainerCreateBroker({ ...harness.broker })).toBe(false)
    expect(Object.keys(harness.broker).sort()).toEqual(['close', 'create'])
    expect(Object.isFrozen(harness.broker)).toBe(true)
    expect(JSON.stringify(harness.broker)).toBe('{}')
  })

  it('rejects cross-endpoint execution before any Engine request', async () => {
    const sourceEngine = await brokerEngine()
    const { manifest, runtimeEvidence } = await liveEvidence(sourceEngine.socketPath)
    const workspace = root('cross-endpoint-broker')
    const filesystem = inspectNodeDockerSidecarFilesystemEvidence({
      kind: 'bash-workspace', root: workspace,
    })
    const command = 'printf cross-endpoint'
    const plan = createLeaseBoundDockerBashContainerCreatePlan({
      semanticDraft: bashDraft(
        filesystem.rootIdentityHash, command, runtimeEvidence.isolationProfileSha256,
      ),
      imageManifest: manifest, filesystem, command, runtimeEvidence,
    })
    const active = await activeFor(plan.endpointIdentity)
    const seal = sealDockerCodeOwnedContainerCreatePlan({ plan, activeEpoch: active.activeEpoch })
    const foreign = await brokerEngine()
    foreign.wire.length = 0
    const broker = makeNodeDockerCodeOwnedContainerCreateBroker({
      seal,
      socketPath: foreign.socketPath,
      timeoutMs: 1_000,
    })

    await expect(broker.create()).rejects.toMatchObject({
      code: 'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_ENDPOINT_MISMATCH',
    })
    expect(foreign.wire).toEqual([])
    expect(active.ledger.listOperations()[0]!.resources[0]!.phase).toBe('prepared')
  })

  it('uses code-only errors and never returns the private bound handle', () => {
    const error = new NodeDockerCodeOwnedContainerCreateBrokerError(
      'DOCKER_CODE_OWNED_CONTAINER_CREATE_BROKER_CREATE_UNRESOLVED',
    )
    expect(error.message).toBe(error.code)
    expect(Object.keys(error)).toEqual(['code', 'name'])
  })
})

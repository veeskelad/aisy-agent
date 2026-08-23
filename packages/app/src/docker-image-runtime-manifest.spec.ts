import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  computeDockerEngineUnixSocketBindingHash,
  makeNodeDockerEnginePinnedSession,
  type DockerEnginePinnedEndpointIdentityV1,
  type DockerEnginePinnedImageInspectEvidenceV1,
} from './docker-engine-pinned-session.js'
import {
  createDockerImageRuntimeManifest,
  DockerImageRuntimeManifestError,
  isDockerImageRuntimeManifest,
} from './docker-image-runtime-manifest.js'

const SERVER_ID = 'docker-engine-primary'
const SERVER_VERSION = '29.5.2'
const IMAGE_ID = `sha256:${'d'.repeat(64)}`
const IMAGE_REFERENCE = `registry.example/aisy/worker@sha256:${'c'.repeat(64)}`
const cleanups: Array<() => Promise<void>> = []

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

async function evidenceFor(
  document: Record<string, unknown>,
): Promise<DockerEnginePinnedImageInspectEvidenceV1> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aisy-image-manifest-')))
  const socketPath = join(root, 'engine.sock')
  const server = createServer((request, response) => {
    if (request.url === '/v1.54/version') {
      return json(response, {
        Version: SERVER_VERSION,
        ApiVersion: '1.55',
        MinAPIVersion: '1.40',
      })
    }
    if (request.url === '/v1.54/info') {
      return json(response, { ID: SERVER_ID, ServerVersion: SERVER_VERSION })
    }
    return json(response, document)
  })
  await listen(server, socketPath)
  cleanups.push(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })
  const pinned = makeNodeDockerEnginePinnedSession({
    socketPath,
    endpointIdentity: identity(socketPath),
    timeoutMs: 1_000,
  })
  try {
    const result = await pinned.inspectImageRuntime(IMAGE_REFERENCE)
    if (result.outcome !== 'found') throw new Error('expected image evidence')
    return result.evidence
  } finally {
    await pinned.close()
  }
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

function imageDocument(configOverrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    Id: IMAGE_ID,
    RepoDigests: [IMAGE_REFERENCE],
    Architecture: 'arm64',
    Os: 'linux',
    Config: {
      User: '65532:65532',
      Env: ['PATH=/usr/bin', 'LANG=C.UTF-8'],
      Entrypoint: ['/worker'],
      Cmd: ['serve'],
      WorkingDir: '/work',
      Labels: { 'org.opencontainers.image.title': 'aisy-worker' },
      Volumes: { '/cache': {} },
      ExposedPorts: { '8080/tcp': {} },
      Healthcheck: {
        Test: ['CMD', '/worker', 'health'],
        Interval: 1_000,
        Timeout: 500,
        StartPeriod: 0,
        StartInterval: 0,
        Retries: 3,
      },
      StopSignal: 'SIGTERM',
      Shell: ['/bin/sh', '-c'],
      OnBuild: [],
      ...configOverrides,
    },
    GraphDriver: { Data: null, Name: 'overlay2' },
  }
}

describe('Docker image runtime manifest', () => {
  it('normalizes genuine pinned evidence into a frozen branded manifest', async () => {
    const evidence = await evidenceFor(imageDocument())

    const manifest = createDockerImageRuntimeManifest(evidence)

    expect(manifest).toMatchObject({
      version: 1,
      kind: 'aisy-docker-image-runtime-manifest-v1',
      imageReference: IMAGE_REFERENCE,
      imageId: IMAGE_ID,
      os: 'linux',
      architecture: 'arm64',
      config: {
        user: '65532:65532',
        env: ['PATH=/usr/bin', 'LANG=C.UTF-8'],
        volumes: ['/cache'],
        exposedPorts: ['8080/tcp'],
      },
    })
    expect(manifest.configHash).toBe(
      '472745030b5241d3ab85bb01a0d19641a2dd0b363eeb6d630da905db297fad5e',
    )
    expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.config)).toBe(true)
    expect(Object.isFrozen(manifest.config.env)).toBe(true)
    expect(isDockerImageRuntimeManifest(manifest)).toBe(true)
    expect(isDockerImageRuntimeManifest({ ...manifest })).toBe(false)
    expect(isDockerImageRuntimeManifest(new Proxy(manifest, {}))).toBe(false)
  })

  it('rejects forged inspect evidence', () => {
    expect(() => createDockerImageRuntimeManifest({
      version: 1,
      endpointIdentity: {},
      requestedDigest: IMAGE_REFERENCE,
      document: imageDocument(),
    } as never)).toThrow(DockerImageRuntimeManifestError)
  })

  it.each([
    ['unknown config field', { Runtime: 'runc' }],
    ['unapproved inherited variable', { Env: ['PATH=/usr/bin', 'APP_MODE=prod'] }],
    ['duplicate inherited variable', { Env: ['LANG=C', 'LANG=C.UTF-8'] }],
    ['Aisy-owned inherited label', { Labels: { 'com.aisy.owner': 'foreign' } }],
    ['invalid exposed port', { ExposedPorts: { '70000/tcp': {} } }],
  ])('fails closed for %s', async (_name, override) => {
    const evidence = await evidenceFor(imageDocument(override))
    expect(() => createDockerImageRuntimeManifest(evidence)).toThrowError(
      expect.objectContaining({ code: 'DOCKER_IMAGE_RUNTIME_MANIFEST_INVALID' }),
    )
  })

  it.each([
    ['unmatched digest', { RepoDigests: [`registry.example/other@${IMAGE_ID}`] }],
    ['duplicate digest', { RepoDigests: [IMAGE_REFERENCE, IMAGE_REFERENCE] }],
    ['malformed image config ID', { Id: `sha256:${'z'.repeat(64)}` }],
    ['unsupported operating system', { Os: 'windows' }],
    ['unsupported architecture', { Architecture: 's390x' }],
  ])('rejects image identity with %s', async (_name, override) => {
    const evidence = await evidenceFor({ ...imageDocument(), ...override })
    expect(() => createDockerImageRuntimeManifest(evidence)).toThrow(DockerImageRuntimeManifestError)
  })

  it('does not execute inherited object or array serialization hooks', async () => {
    const evidence = await evidenceFor(imageDocument())
    const objectBefore = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    const arrayBefore = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
    let calls = 0
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => { calls += 1; return { changed: true } },
    })
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: () => { calls += 1; return ['changed'] },
    })
    try {
      expect(createDockerImageRuntimeManifest(evidence).manifestHash).toMatch(/^[a-f0-9]{64}$/)
      expect(calls).toBe(0)
    } finally {
      if (objectBefore === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON
      else Object.defineProperty(Object.prototype, 'toJSON', objectBefore)
      if (arrayBefore === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON
      else Object.defineProperty(Array.prototype, 'toJSON', arrayBefore)
    }
  })
})

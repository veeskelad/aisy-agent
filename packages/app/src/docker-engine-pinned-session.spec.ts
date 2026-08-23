import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  computeDockerEngineUnixSocketBindingHash,
  DockerEnginePinnedSessionError,
  isDockerEnginePinnedImageInspectEvidence,
  isDockerEnginePinnedSandboxRuntimeEvidence,
  isDockerEnginePinnedSession,
  makeNodeDockerEnginePinnedSession,
  PINNED_DOCKER_ENGINE_API_IDENTITY,
  PINNED_DOCKER_ENGINE_API_VERSION,
  type DockerEnginePinnedEndpointIdentityV1,
} from './docker-engine-pinned-session.js'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

const SERVER_ID = 'docker-engine-primary'
const SERVER_VERSION = '29.5.2'
const CONTAINER_ID = 'a'.repeat(64)
const NETWORK_ID = 'b'.repeat(64)
const IMAGE_DIGEST = `registry.example/aisy/worker@sha256:${'c'.repeat(64)}`
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

async function fixture(handler: Handler): Promise<Readonly<{
  root: string
  socketPath: string
  server: Server
}>> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aisy-pinned-engine-')))
  const socketPath = join(root, 'engine.sock')
  const server = createServer(handler)
  await listen(server, socketPath)
  cleanups.push(async () => {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    rmSync(root, { recursive: true, force: true })
  })
  return Object.freeze({ root, socketPath, server })
}

function json(response: ServerResponse, value: unknown, headers?: Record<string, string>): void {
  response.writeHead(200, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(value))
}

function versionDocument(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    Version: SERVER_VERSION,
    ApiVersion: '1.55',
    MinAPIVersion: '1.40',
    ...overrides,
  }
}

function infoDocument(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    ID: SERVER_ID,
    ServerVersion: SERVER_VERSION,
    ...overrides,
  }
}

function identity(socketPath: string, overrides?: Partial<DockerEnginePinnedEndpointIdentityV1>): DockerEnginePinnedEndpointIdentityV1 {
  return {
    version: 1,
    endpointBindingHash: computeDockerEngineUnixSocketBindingHash(socketPath),
    serverId: SERVER_ID,
    serverVersion: SERVER_VERSION,
    apiVersion: PINNED_DOCKER_ENGINE_API_IDENTITY,
    ...overrides,
  }
}

function session(socketPath: string, overrides?: Partial<DockerEnginePinnedEndpointIdentityV1>) {
  return makeNodeDockerEnginePinnedSession({
    socketPath,
    endpointIdentity: identity(socketPath, overrides),
    timeoutMs: 1_000,
  })
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe('pinned Docker Engine session', () => {
  it('attests and inspects through one physical socket in exact v1.54 order', async () => {
    const urls: string[] = []
    const requestSockets = new Set<Socket>()
    let connections = 0
    const endpoint = await fixture((request, response) => {
      urls.push(request.url ?? '')
      requestSockets.add(request.socket)
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      return json(response, { Id: CONTAINER_ID, Name: '/owned' })
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID)).resolves.toEqual({
      outcome: 'found',
      statusCode: 200,
      document: { Id: CONTAINER_ID, Name: '/owned' },
    })
    await pinned.close()

    expect(PINNED_DOCKER_ENGINE_API_VERSION).toBe('v1.54')
    expect(urls).toEqual([
      '/v1.54/version',
      '/v1.54/info',
      `/v1.54/containers/${CONTAINER_ID}/json`,
    ])
    expect(connections).toBe(1)
    expect(requestSockets.size).toBe(1)
  })

  it('attests a digest-qualified image runtime as genuine frozen evidence', async () => {
    const wire: Array<Readonly<{ method: string | undefined; url: string | undefined }>> = []
    const requestSockets = new Set<Socket>()
    let connections = 0
    const imageDocument = {
      Id: `sha256:${'d'.repeat(64)}`,
      RepoDigests: [IMAGE_DIGEST],
      Architecture: 'arm64',
      Os: 'linux',
      Config: { User: '65532:65532', Env: ['LANG=C.UTF-8'] },
    }
    const endpoint = await fixture((request, response) => {
      wire.push({ method: request.method, url: request.url })
      requestSockets.add(request.socket)
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      return json(response, imageDocument)
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const pinned = session(endpoint.socketPath)

    const result = await pinned.inspectImageRuntime(IMAGE_DIGEST)

    expect(result).toMatchObject({ outcome: 'found', statusCode: 200 })
    if (result.outcome !== 'found') throw new Error('expected image evidence')
    expect(result.evidence).toMatchObject({
      version: 1,
      endpointIdentity: identity(endpoint.socketPath),
      requestedDigest: IMAGE_DIGEST,
      document: imageDocument,
    })
    expect(isDockerEnginePinnedImageInspectEvidence(result.evidence)).toBe(true)
    expect(isDockerEnginePinnedImageInspectEvidence({ ...result.evidence })).toBe(false)
    expect(isDockerEnginePinnedImageInspectEvidence(new Proxy(result.evidence, {}))).toBe(false)
    expect(Object.isFrozen(result.evidence)).toBe(true)
    expect(Object.isFrozen(result.evidence.endpointIdentity)).toBe(true)
    expect(Object.isFrozen(result.evidence.document)).toBe(true)
    expect(Object.isFrozen(result.evidence.document['Config'])).toBe(true)
    expect(wire).toEqual([
      { method: 'GET', url: '/v1.54/version' },
      { method: 'GET', url: '/v1.54/info' },
      { method: 'GET', url: `/v1.54/images/${encodeURIComponent(IMAGE_DIGEST)}/json` },
    ])
    expect(connections).toBe(1)
    expect(requestSockets.size).toBe(1)
  })

  it('derives genuine full sandbox runtime evidence from the pinned daemon info', async () => {
    const urls: string[] = []
    const endpoint = await fixture((request, response) => {
      urls.push(request.url ?? '')
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      return json(response, infoDocument({
        SecurityOptions: ['name=seccomp,profile=builtin', 'name=userns'],
        Runtimes: { runc: {}, runsc: {} },
      }))
    })
    const pinned = session(endpoint.socketPath)

    const evidence = await pinned.attestSandboxRuntime()
    await pinned.close()

    expect(evidence).toMatchObject({
      version: 1,
      endpointIdentity: identity(endpoint.socketPath),
      runtime: 'runsc',
      securityLevel: 'full',
      userNamespaceMode: 'userns-remap',
    })
    expect(evidence.isolationProfileSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(evidence.runtimeEvidenceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(isDockerEnginePinnedSandboxRuntimeEvidence(evidence)).toBe(true)
    expect(isDockerEnginePinnedSandboxRuntimeEvidence({ ...evidence })).toBe(false)
    expect(isDockerEnginePinnedSandboxRuntimeEvidence(new Proxy(evidence, {}))).toBe(false)
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(urls).toEqual(['/v1.54/version', '/v1.54/info'])
  })

  it('fails closed when daemon isolation or a reviewed runtime is absent', async () => {
    for (const info of [
      infoDocument({
        SecurityOptions: ['name=seccomp,profile=builtin'],
        Runtimes: { runc: {}, runsc: {} },
      }),
      infoDocument({
        SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'],
        Runtimes: { unreviewed: {} },
      }),
    ]) {
      const endpoint = await fixture((request, response) => {
        if (request.url === '/v1.54/version') return json(response, versionDocument())
        return json(response, info)
      })
      const pinned = session(endpoint.socketPath)
      await expect(pinned.attestSandboxRuntime()).rejects.toMatchObject({
        code: 'DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE',
      })
      await pinned.close()
    }
  })

  it('returns typed image not-found without manufacturing evidence and remains one-shot', async () => {
    const methods: string[] = []
    const endpoint = await fixture((request, response) => {
      methods.push(request.method ?? '')
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'localized' }))
    })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectImageRuntime(IMAGE_DIGEST)).resolves.toEqual({
      outcome: 'not-found',
      statusCode: 404,
    })
    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_COMMAND_ALREADY_USED',
    })
    expect(methods).toEqual(['GET', 'GET', 'GET'])
  })

  it.each([
    ['tag', 'registry.example/aisy/worker:latest'],
    ['uppercase', `Registry.example/aisy/worker@sha256:${'c'.repeat(64)}`],
    ['option-like', `--help@sha256:${'c'.repeat(64)}`],
    ['oversized', `${'a'.repeat(441)}@sha256:${'c'.repeat(64)}`],
  ])('rejects an invalid image %s before socket I/O', async (_name, requestedDigest) => {
    let connections = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    endpoint.server.on('connection', () => { connections += 1 })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectImageRuntime(requestedDigest)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_INPUT_INVALID',
    })
    expect(connections).toBe(0)
  })

  it('rejects an image response cap above 256 KiB before socket I/O', async () => {
    let connections = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    endpoint.server.on('connection', () => { connections += 1 })

    expect(() => makeNodeDockerEnginePinnedSession({
      socketPath: endpoint.socketPath,
      endpointIdentity: identity(endpoint.socketPath),
      maxResponseBytes: 256 * 1024 + 1,
    })).toThrowError(expect.objectContaining({ code: 'DOCKER_ENGINE_PINNED_INPUT_INVALID' }))
    expect(connections).toBe(0)
  })

  it.each(['status', 'malformed-json', 'oversized-body'] as const)(
    'treats an image %s response as ambiguous without retry',
    async fault => {
      let connections = 0
      const urls: string[] = []
      const endpoint = await fixture((request, response) => {
        urls.push(request.url ?? '')
        if (request.url === '/v1.54/version') return json(response, versionDocument())
        if (request.url === '/v1.54/info') return json(response, infoDocument())
        if (fault === 'status') {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end('{}')
          return
        }
        if (fault === 'malformed-json') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{')
          return
        }
        json(response, { value: 'x'.repeat(2_048) })
      })
      endpoint.server.on('connection', () => { connections += 1 })
      const pinned = makeNodeDockerEnginePinnedSession({
        socketPath: endpoint.socketPath,
        endpointIdentity: identity(endpoint.socketPath),
        maxResponseBytes: 1_024,
        timeoutMs: 1_000,
      })

      await expect(pinned.inspectImageRuntime(IMAGE_DIGEST)).rejects.toMatchObject({
        code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
      })
      expect(urls).toEqual([
        '/v1.54/version',
        '/v1.54/info',
        `/v1.54/images/${encodeURIComponent(IMAGE_DIGEST)}/json`,
      ])
      expect(connections).toBe(1)
    },
  )

  it('treats abort during image runtime inspect as ambiguous and mints no evidence', async () => {
    let imageReceived!: () => void
    const received = new Promise<void>(resolve => { imageReceived = resolve })
    const endpoint = await fixture((request, response) => {
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      imageReceived()
    })
    const controller = new AbortController()
    const pinned = session(endpoint.socketPath)
    const operation = pinned.inspectImageRuntime(IMAGE_DIGEST, { signal: controller.signal })
    await received

    controller.abort()

    await expect(operation).rejects.toMatchObject({ code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS' })
    await expect(pinned.close()).resolves.toBeUndefined()
  })

  it('accepts a daemon range containing 1.54 without negotiation or fallback', async () => {
    const urls: string[] = []
    const endpoint = await fixture((request, response) => {
      urls.push(request.url ?? '')
      if (request.url === '/v1.54/version') {
        return json(response, versionDocument({ ApiVersion: '1.55', MinAPIVersion: '1.40' }))
      }
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      return json(response, { Id: NETWORK_ID, Name: 'owned-network' })
    })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectNetwork('owned-network')).resolves.toMatchObject({ outcome: 'found' })

    expect(urls).toEqual([
      '/v1.54/version',
      '/v1.54/info',
      '/v1.54/networks/owned-network',
    ])
    expect(urls.every(url => url.startsWith('/v1.54/'))).toBe(true)
  })

  it.each([
    ['server version', versionDocument({ Version: '29.5.3' }), infoDocument(), 'DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH'],
    ['old server version', versionDocument({ Version: '29.5.1' }), infoDocument(), 'DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE'],
    ['non-canonical server version', versionDocument({ Version: '029.5.2' }), infoDocument(), 'DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE'],
    ['server id', versionDocument(), infoDocument({ ID: 'replacement-engine' }), 'DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH'],
    ['maximum API', versionDocument({ ApiVersion: '1.53' }), infoDocument(), 'DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE'],
    ['minimum API', versionDocument({ MinAPIVersion: '1.55' }), infoDocument(), 'DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE'],
    ['non-canonical API', versionDocument({ ApiVersion: '1.055' }), infoDocument(), 'DOCKER_ENGINE_PINNED_DAEMON_INCOMPATIBLE'],
  ])('rejects wrong %s before the proof command', async (_name, version, info, code) => {
    const urls: string[] = []
    const endpoint = await fixture((request, response) => {
      urls.push(request.url ?? '')
      if (request.url === '/v1.54/version') return json(response, version)
      if (request.url === '/v1.54/info') return json(response, info)
      return json(response, { Id: CONTAINER_ID })
    })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({ code })

    expect(urls).not.toContain(`/v1.54/containers/${CONTAINER_ID}/json`)
  })

  it.each(['old', 'non-canonical'])('rejects an %s persisted server version before I/O', async kind => {
    let connections = 0
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    endpoint.server.on('connection', () => { connections += 1 })
    const endpointIdentity = identity(endpoint.socketPath, {
      serverVersion: kind === 'old' ? '29.5.1' : '029.5.2',
    })

    expect(() => makeNodeDockerEnginePinnedSession({
      socketPath: endpoint.socketPath,
      endpointIdentity,
    })).toThrowError(expect.objectContaining({ code: 'DOCKER_ENGINE_PINNED_INPUT_INVALID' }))
    expect(connections).toBe(0)
  })

  it('snapshots only exact own enumerable data properties for endpoint identity', async () => {
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const base = identity(endpoint.socketPath)
    let getterCalls = 0
    const accessor = { ...base } as Record<string, unknown>
    Object.defineProperty(accessor, 'serverId', {
      enumerable: true,
      get() {
        getterCalls += 1
        return SERVER_ID
      },
    })
    const symbolBearing = { ...base, [Symbol('unexpected')]: true }
    const proxy = new Proxy({ ...base }, {})
    const nonEnumerable = { ...base }
    Object.defineProperty(nonEnumerable, 'serverId', { value: SERVER_ID, enumerable: false })

    for (const endpointIdentity of [accessor, symbolBearing, proxy, nonEnumerable]) {
      expect(() => makeNodeDockerEnginePinnedSession({
        socketPath: endpoint.socketPath,
        endpointIdentity: endpointIdentity as unknown as DockerEnginePinnedEndpointIdentityV1,
      })).toThrowError(expect.objectContaining({ code: 'DOCKER_ENGINE_PINNED_INPUT_INVALID' }))
    }
    expect(getterCalls).toBe(0)
  })

  it('snapshots only exact own enumerable data properties for factory options', async () => {
    const endpoint = await fixture((_request, response) => json(response, versionDocument()))
    const endpointIdentity = identity(endpoint.socketPath)
    let getterCalls = 0
    const accessor = { endpointIdentity } as Record<string, unknown>
    Object.defineProperty(accessor, 'socketPath', {
      enumerable: true,
      get() {
        getterCalls += 1
        return endpoint.socketPath
      },
    })
    const proxy = new Proxy({ socketPath: endpoint.socketPath, endpointIdentity }, {})
    const symbolBearing = {
      socketPath: endpoint.socketPath,
      endpointIdentity,
      [Symbol('unexpected')]: true,
    }
    const unknown = { socketPath: endpoint.socketPath, endpointIdentity, retry: true }
    const nonEnumerable = { endpointIdentity } as Record<string, unknown>
    Object.defineProperty(nonEnumerable, 'socketPath', {
      value: endpoint.socketPath,
      enumerable: false,
    })
    const nonPlain = Object.assign(Object.create(null) as Record<string, unknown>, {
      socketPath: endpoint.socketPath,
      endpointIdentity,
    })

    for (const options of [accessor, proxy, symbolBearing, unknown, nonEnumerable, nonPlain]) {
      expect(() => makeNodeDockerEnginePinnedSession(
        options as unknown as Parameters<typeof makeNodeDockerEnginePinnedSession>[0],
      )).toThrowError(expect.objectContaining({
        code: 'DOCKER_ENGINE_PINNED_INPUT_INVALID',
        message: 'DOCKER_ENGINE_PINNED_INPUT_INVALID',
      }))
    }
    expect(getterCalls).toBe(0)
  })

  it('uses immutable option and identity snapshots after factory return', async () => {
    const urls: string[] = []
    const endpoint = await fixture((request, response) => {
      urls.push(request.url ?? '')
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      return json(response, { Id: CONTAINER_ID })
    })
    const endpointIdentity = identity(endpoint.socketPath)
    const options = {
      socketPath: endpoint.socketPath,
      endpointIdentity,
      timeoutMs: 1_000,
    }
    const pinned = makeNodeDockerEnginePinnedSession(options)

    options.socketPath = join(endpoint.root, 'replacement.sock')
    ;(endpointIdentity as { serverId: string }).serverId = 'replacement-engine'
    options.timeoutMs = 1

    await expect(pinned.inspectContainer(CONTAINER_ID)).resolves.toMatchObject({ outcome: 'found' })
    expect(pinned.endpointIdentity.serverId).toBe(SERVER_ID)
    expect(urls).toEqual([
      '/v1.54/version',
      '/v1.54/info',
      `/v1.54/containers/${CONTAINER_ID}/json`,
    ])
    await pinned.close()
  })

  it.each([
    ['container', CONTAINER_ID],
    ['network', NETWORK_ID],
    ['image', IMAGE_DIGEST],
  ] as const)('rejects hostile per-call options before consuming the %s session', async (kind, reference) => {
    let connections = 0
    const endpoint = await fixture((request, response) => {
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      return json(response, { Id: reference })
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const pinned = session(endpoint.socketPath)
    const call = (options?: Readonly<{ signal?: AbortSignal }>) => {
      if (kind === 'container') return pinned.inspectContainer(reference, options)
      if (kind === 'network') return pinned.inspectNetwork(reference, options)
      return pinned.inspectImageRuntime(reference, options)
    }
    let getterCalls = 0
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'signal', {
      enumerable: true,
      get() {
        getterCalls += 1
        return new AbortController().signal
      },
    })
    let proxyTrapCalls = 0
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        proxyTrapCalls += 1
        return Object.prototype
      },
      ownKeys() {
        proxyTrapCalls += 1
        return []
      },
    })
    const symbolBearing = { [Symbol('unexpected')]: true }
    const unknown = { retry: true }
    const nonPlain = Object.create(null) as Record<string, unknown>
    const forgedSignal = { signal: { aborted: false } }

    for (const options of [accessor, proxy, symbolBearing, unknown, nonPlain, forgedSignal]) {
      await expect(call(
        options as unknown as Readonly<{ signal?: AbortSignal }>,
      )).rejects.toMatchObject({
        code: 'DOCKER_ENGINE_PINNED_INPUT_INVALID',
        message: 'DOCKER_ENGINE_PINNED_INPUT_INVALID',
      })
      expect(connections).toBe(0)
    }
    expect(getterCalls).toBe(0)
    expect(proxyTrapCalls).toBe(0)

    await expect(call({ signal: new AbortController().signal })).resolves.toMatchObject({
      outcome: 'found',
      statusCode: 200,
    })
    expect(connections).toBe(1)
  })

  it('rejects a replaced socket anchor before opening a connection', async () => {
    let requests = 0
    const endpoint = await fixture((_request, response) => {
      requests += 1
      json(response, versionDocument())
    })
    const expected = identity(endpoint.socketPath)
    const replacement = createServer((_request, response) => json(response, versionDocument()))
    unlinkSync(endpoint.socketPath)
    await listen(replacement, endpoint.socketPath)
    cleanups.push(async () => {
      replacement.closeAllConnections()
      if (replacement.listening) await new Promise<void>(resolve => replacement.close(() => resolve()))
    })
    const pinned = makeNodeDockerEnginePinnedSession({
      socketPath: endpoint.socketPath,
      endpointIdentity: expected,
    })

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH',
    })
    expect(requests).toBe(0)
  })

  it.each(['world-writable', 'symlink'])('rejects a %s socket anchor', async kind => {
    let requests = 0
    const endpoint = await fixture((_request, response) => {
      requests += 1
      json(response, versionDocument())
    })
    let configuredPath = endpoint.socketPath
    if (kind === 'world-writable') {
      chmodSync(endpoint.socketPath, 0o777)
    } else {
      configuredPath = join(endpoint.root, 'engine-alias.sock')
      symlinkSync(endpoint.socketPath, configuredPath)
    }

    expect(() => computeDockerEngineUnixSocketBindingHash(configuredPath)).toThrowError(
      expect.objectContaining({ code: 'DOCKER_ENGINE_PINNED_ENDPOINT_MISMATCH' }),
    )
    expect(requests).toBe(0)
  })

  it.each(['version', 'info'])('detects socket replacement after %s without sending the command', async stage => {
    const urls: string[] = []
    let replacementRequests = 0
    let replaced = false
    let endpoint!: Awaited<ReturnType<typeof fixture>>
    const replace = async (): Promise<void> => {
      if (replaced) return
      replaced = true
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
      urls.push(request.url ?? '')
      if (request.url === '/v1.54/version') {
        if (stage === 'version') {
          void replace().then(() => json(response, versionDocument()))
          return
        }
        return json(response, versionDocument())
      }
      if (request.url === '/v1.54/info') {
        void replace().then(() => json(response, infoDocument()))
        return
      }
      json(response, { Id: CONTAINER_ID })
    })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })

    expect(urls).not.toContain(`/v1.54/containers/${CONTAINER_ID}/json`)
    expect(replacementRequests).toBe(0)
  })

  it('detects socket replacement before accepting a completed proof command', async () => {
    let endpoint!: Awaited<ReturnType<typeof fixture>>
    let replaced = false
    const replace = async (): Promise<void> => {
      if (replaced) return
      replaced = true
      unlinkSync(endpoint.socketPath)
      const replacement = createServer((_request, response) => json(response, infoDocument()))
      await listen(replacement, endpoint.socketPath)
      cleanups.push(async () => {
        replacement.closeAllConnections()
        if (replacement.listening) await new Promise<void>(resolve => replacement.close(() => resolve()))
      })
    }
    endpoint = await fixture((request, response) => {
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      void replace().then(() => json(response, { Id: CONTAINER_ID }))
    })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })
  })

  it('treats Connection: close as ambiguous and never reconnects', async () => {
    const urls: string[] = []
    let connections = 0
    const endpoint = await fixture((request, response) => {
      urls.push(request.url ?? '')
      json(response, versionDocument(), { connection: 'close' })
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })

    expect(urls).toEqual(['/v1.54/version'])
    expect(connections).toBe(1)
  })

  it.each(['combined', 'double'])('rejects %s Connection close tokens without reconnect', async kind => {
    const urls: string[] = []
    let connections = 0
    const endpoint = await fixture((request, response) => {
      urls.push(request.url ?? '')
      const body = JSON.stringify(versionDocument())
      if (kind === 'combined') {
        response.writeHead(200, {
          'content-type': 'application/json',
          connection: ' keep-alive , CLOSE ',
        })
      } else {
        response.writeHead(200, [
          'content-type', 'application/json',
          'connection', 'keep-alive',
          'connection', 'close',
        ])
      }
      response.end(body)
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })
    expect(urls).toEqual(['/v1.54/version'])
    expect(connections).toBe(1)
  })

  it('treats a truncated response as ambiguous', async () => {
    const endpoint = await fixture((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '4096',
      })
      response.write('{"Version":"29')
      response.destroy()
    })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })
  })

  it.each(['body', 'header'])('bounds response %s before attestation', async kind => {
    const endpoint = await fixture((_request, response) => {
      if (kind === 'header') {
        json(response, versionDocument(), { 'x-oversized': 'x'.repeat(20 * 1024) })
        return
      }
      json(response, versionDocument())
    })
    const pinned = makeNodeDockerEnginePinnedSession({
      socketPath: endpoint.socketPath,
      endpointIdentity: identity(endpoint.socketPath),
      ...(kind === 'body' ? { maxResponseBytes: 8 } : {}),
    })

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })
  })

  it('rejects 65 response headers without Node truncation', async () => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    for (let index = 0; index < 65; index += 1) headers[`x-proof-${index}`] = String(index)
    const endpoint = await fixture((_request, response) => {
      response.writeHead(200, headers)
      response.end(JSON.stringify(versionDocument()))
    })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })
  })

  it('rejects 65 raw trailers without Node truncation', async () => {
    const trailers: Record<string, string> = {}
    for (let index = 0; index < 65; index += 1) trailers[`x-proof-${index}`] = String(index)
    const endpoint = await fixture((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        trailer: Object.keys(trailers).join(', '),
      })
      response.addTrailers(trailers)
      response.end(JSON.stringify(versionDocument()))
    })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })
  })

  it('treats AbortSignal during the proof command as ambiguous', async () => {
    let commandReceived!: () => void
    const received = new Promise<void>(resolve => { commandReceived = resolve })
    const endpoint = await fixture((request, response) => {
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      commandReceived()
    })
    const controller = new AbortController()
    const pinned = session(endpoint.socketPath)
    const pending = pinned.inspectContainer(CONTAINER_ID, { signal: controller.signal })
    await received

    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS' })
    await expect(pinned.close()).resolves.toBeUndefined()
  })

  it('rejects a pre-aborted signal without socket or HTTP I/O', async () => {
    let connections = 0
    let requests = 0
    const endpoint = await fixture((_request, response) => {
      requests += 1
      json(response, versionDocument())
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const controller = new AbortController()
    controller.abort()
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID, { signal: controller.signal })).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })
    expect(connections).toBe(0)
    expect(requests).toBe(0)
  })

  it('aborts during Unix connect before any HTTP request', async () => {
    let requests = 0
    const endpoint = await fixture((_request, response) => {
      requests += 1
      json(response, versionDocument())
    })
    const controller = new AbortController()
    const pinned = session(endpoint.socketPath)
    const pending = pinned.inspectContainer(CONTAINER_ID, { signal: controller.signal })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS' })
    expect(requests).toBe(0)
    await pinned.close()
  })

  it('treats a total session timeout as ambiguous', async () => {
    const endpoint = await fixture(() => undefined)
    const pinned = makeNodeDockerEnginePinnedSession({
      socketPath: endpoint.socketPath,
      endpointIdentity: identity(endpoint.socketPath),
      timeoutMs: 20,
    })

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })
    await pinned.close()
  })

  it('brands only factory-created sessions and freezes their identity', async () => {
    const endpoint = await fixture((request, response) => {
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      return json(response, { Id: CONTAINER_ID })
    })
    const pinned = session(endpoint.socketPath)
    const structuralFake = {
      endpointIdentity: identity(endpoint.socketPath),
      inspectContainer: pinned.inspectContainer,
      inspectNetwork: pinned.inspectNetwork,
      close: pinned.close,
    }

    expect(isDockerEnginePinnedSession(pinned)).toBe(true)
    expect(isDockerEnginePinnedSession(structuralFake)).toBe(false)
    expect(Object.isFrozen(pinned)).toBe(true)
    expect(Object.isFrozen(pinned.endpointIdentity)).toBe(true)
    await pinned.close()
  })

  it('admits exactly one proof command', async () => {
    let requests = 0
    const endpoint = await fixture((request, response) => {
      requests += 1
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      return json(response, { Id: CONTAINER_ID })
    })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(CONTAINER_ID)).resolves.toMatchObject({ outcome: 'found' })
    await expect(pinned.inspectNetwork('owned')).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_COMMAND_ALREADY_USED',
    })
    expect(requests).toBe(3)
    await pinned.close()
  })

  it('admits exactly one of two concurrent inspect calls without extra I/O', async () => {
    let connections = 0
    const urls: string[] = []
    let finishCommand!: () => void
    let commandReceived!: () => void
    const received = new Promise<void>(resolve => { commandReceived = resolve })
    const release = new Promise<void>(resolve => { finishCommand = resolve })
    const endpoint = await fixture((request, response) => {
      urls.push(request.url ?? '')
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      commandReceived()
      void release.then(() => json(response, { Id: CONTAINER_ID }))
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const pinned = session(endpoint.socketPath)

    const admitted = pinned.inspectContainer(CONTAINER_ID)
    const refused = pinned.inspectNetwork('owned-network')
    await expect(refused).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_COMMAND_ALREADY_USED',
    })
    await received
    finishCommand()
    await expect(admitted).resolves.toMatchObject({ outcome: 'found' })

    expect(connections).toBe(1)
    expect(urls).toEqual([
      '/v1.54/version',
      '/v1.54/info',
      `/v1.54/containers/${CONTAINER_ID}/json`,
    ])
    await pinned.close()
  })

  it.each(['.', '..'])('rejects path segment %s before any socket I/O', async reference => {
    let connections = 0
    let requests = 0
    const endpoint = await fixture((_request, response) => {
      requests += 1
      json(response, versionDocument())
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(reference)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_INPUT_INVALID',
    })
    expect(connections).toBe(0)
    expect(requests).toBe(0)
  })

  it('rejects a coercible hostile reference without invoking it or opening a socket', async () => {
    let connections = 0
    let requests = 0
    let coercions = 0
    const endpoint = await fixture((_request, response) => {
      requests += 1
      json(response, versionDocument())
    })
    endpoint.server.on('connection', () => { connections += 1 })
    const hostile = {
      [Symbol.toPrimitive]() {
        coercions += 1
        return CONTAINER_ID
      },
    }
    const pinned = session(endpoint.socketPath)

    await expect(pinned.inspectContainer(hostile as unknown as string)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_INPUT_INVALID',
      message: 'DOCKER_ENGINE_PINNED_INPUT_INVALID',
    })
    expect(coercions).toBe(0)
    expect(connections).toBe(0)
    expect(requests).toBe(0)
  })

  it('closes admission, drains an in-flight command and closes idempotently', async () => {
    let finishCommand!: () => void
    let commandReceived!: () => void
    const received = new Promise<void>(resolve => { commandReceived = resolve })
    const release = new Promise<void>(resolve => { finishCommand = resolve })
    const endpoint = await fixture((request, response) => {
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      commandReceived()
      void release.then(() => json(response, { Id: CONTAINER_ID }))
    })
    const pinned = session(endpoint.socketPath)
    const operation = pinned.inspectContainer(CONTAINER_ID)
    await received
    const closing = pinned.close()
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()

    expect(closed).toBe(false)
    await expect(pinned.inspectNetwork('owned')).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_SESSION_CLOSED',
    })
    finishCommand()
    await expect(operation).resolves.toMatchObject({ outcome: 'found' })
    await expect(closing).resolves.toBeUndefined()
    await expect(pinned.close()).resolves.toBeUndefined()
  })

  it('bounds JSON complexity and never exposes CLI or child_process', async () => {
    const endpoint = await fixture((request, response) => {
      if (request.url === '/v1.54/version') return json(response, versionDocument())
      if (request.url === '/v1.54/info') return json(response, infoDocument())
      return json(response, { one: 1, two: 2, three: 3 })
    })
    const pinned = makeNodeDockerEnginePinnedSession({
      socketPath: endpoint.socketPath,
      endpointIdentity: identity(endpoint.socketPath),
      maxJsonNodes: 3,
    })

    await expect(pinned.inspectContainer(CONTAINER_ID)).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_PINNED_AMBIGUOUS',
    })
    const source = readFileSync(new URL('./docker-engine-pinned-session.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/node:child_process|docker\s+inspect|docker\s+network/)
  })

  it('uses stable code-only errors', () => {
    const error = new DockerEnginePinnedSessionError('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    expect(error.message).toBe('DOCKER_ENGINE_PINNED_AMBIGUOUS')
    expect(Object.keys(error)).toEqual(['code', 'name'])
  })
})

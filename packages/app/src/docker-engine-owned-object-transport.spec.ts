import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DOCKER_ENGINE_API_VERSION,
  DockerEngineOwnedObjectTransportError,
  makeNodeDockerEngineOwnedObjectTransport,
} from './docker-engine-owned-object-transport.js'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

const fixtures: Array<() => Promise<void>> = []
const CONTAINER_ID = 'a'.repeat(64)
const NETWORK_ID = 'b'.repeat(64)

async function fixture(handler: Handler): Promise<Readonly<{
  socketPath: string
}>> {
  const root = mkdtempSync(join(tmpdir(), 'aisy-engine-'))
  const socketPath = join(root, 'engine.sock')
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  fixtures.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
      server.closeAllConnections()
    })
    rmSync(root, { recursive: true, force: true })
  })
  return Object.freeze({ socketPath })
}

afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.()
})

describe('Node Docker Engine owned-object transport', () => {
  it('uses the exact API version over the explicit unix socket for inspect', async () => {
    let observed: Readonly<{
      method: string | undefined
      url: string | undefined
    }> = { method: undefined, url: undefined }
    const server = await fixture((request, response) => {
      observed = { method: request.method, url: request.url }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        Id: 'owned',
        State: { Running: false, Health: { Status: 'none' } },
        Mounts: [{ Type: 'tmpfs' }],
      }))
    })
    const transport = makeNodeDockerEngineOwnedObjectTransport({ socketPath: server.socketPath })

    const result = await transport.inspectContainer('owned')

    expect(DOCKER_ENGINE_API_VERSION).toBe('v1.54')
    expect(observed).toEqual({ method: 'GET', url: '/v1.54/containers/owned/json' })
    expect(result).toEqual({
      outcome: 'found',
      statusCode: 200,
      document: {
        Id: 'owned',
        State: { Running: false, Health: { Status: 'none' } },
        Mounts: [{ Type: 'tmpfs' }],
      },
    })
    if (result.outcome !== 'found') throw new Error('expected found')
    expect(Object.isFrozen(result.document)).toBe(true)
    expect(Object.isFrozen(result.document['State'])).toBe(true)
    expect(Object.isFrozen(result.document['Mounts'])).toBe(true)
    expect(Object.isFrozen((result.document['Mounts'] as unknown[])[0])).toBe(true)
    expect(() => {
      (result.document['State'] as Record<string, unknown>)['Running'] = true
    }).toThrow(TypeError)
  })

  it('returns typed object-not-found from HTTP status without parsing its message', async () => {
    const server = await fixture((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"message":"localized and intentionally ignored"}')
    })
    const transport = makeNodeDockerEngineOwnedObjectTransport({ socketPath: server.socketPath })

    await expect(transport.inspectContainer('missing')).resolves.toEqual({
      outcome: 'not-found',
      statusCode: 404,
    })
  })

  it('force-removes owned containers with volumes through the exact endpoint', async () => {
    let observed: Readonly<{
      method: string | undefined
      url: string | undefined
    }> = { method: undefined, url: undefined }
    const server = await fixture((request, response) => {
      observed = { method: request.method, url: request.url }
      response.writeHead(204)
      response.end()
    })
    const transport = makeNodeDockerEngineOwnedObjectTransport({ socketPath: server.socketPath })

    await expect(transport.removeContainer(CONTAINER_ID)).resolves.toEqual({
      outcome: 'removed',
      statusCode: 204,
    })
    expect(observed).toEqual({
      method: 'DELETE',
      url: `/v1.54/containers/${CONTAINER_ID}?force=1&v=1`,
    })
  })

  it('returns typed object-not-found for idempotent cleanup', async () => {
    const server = await fixture((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"message":"gone"}')
    })
    const transport = makeNodeDockerEngineOwnedObjectTransport({ socketPath: server.socketPath })

    await expect(transport.removeContainer(CONTAINER_ID)).resolves.toEqual({
      outcome: 'not-found',
      statusCode: 404,
    })
  })

  it('reports non-success HTTP status as typed code-only failure', async () => {
    const server = await fixture((_request, response) => {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end('{"message":"must not escape"}')
    })
    const transport = makeNodeDockerEngineOwnedObjectTransport({ socketPath: server.socketPath })

    await expect(transport.removeContainer(CONTAINER_ID)).rejects.toMatchObject({
      name: 'DockerEngineOwnedObjectTransportError',
      message: 'DOCKER_ENGINE_HTTP_STATUS',
      code: 'DOCKER_ENGINE_HTTP_STATUS',
      statusCode: 409,
    })
  })

  it('bounds response bytes before returning typed status', async () => {
    const server = await fixture((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"message":"body exceeds the configured cap"}')
    })
    const transport = makeNodeDockerEngineOwnedObjectTransport({
      socketPath: server.socketPath,
      maxResponseBytes: 8,
    })

    await expect(transport.inspectContainer('missing')).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_RESPONSE_TOO_LARGE',
      statusCode: null,
    })
  })

  it('bounds inspect JSON cardinality', async () => {
    const server = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"one":1,"two":2,"three":3}')
    })
    const transport = makeNodeDockerEngineOwnedObjectTransport({
      socketPath: server.socketPath,
      maxJsonNodes: 3,
    })

    await expect(transport.inspectContainer('owned')).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_RESPONSE_TOO_COMPLEX',
      statusCode: null,
    })
  })

  it('enforces a total request timeout', async () => {
    const server = await fixture(() => undefined)
    const transport = makeNodeDockerEngineOwnedObjectTransport({
      socketPath: server.socketPath,
      timeoutMs: 20,
    })

    await expect(transport.inspectContainer('owned')).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_TIMEOUT',
      statusCode: null,
    })
  })

  it('honours AbortSignal for an in-flight request', async () => {
    let received!: () => void
    const requestReceived = new Promise<void>(resolve => { received = resolve })
    const server = await fixture(() => { received() })
    const transport = makeNodeDockerEngineOwnedObjectTransport({
      socketPath: server.socketPath,
      timeoutMs: 1_000,
    })
    const controller = new AbortController()
    const pending = transport.inspectContainer('owned', { signal: controller.signal })
    await requestReceived

    controller.abort()

    await expect(pending).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_ABORTED',
      statusCode: null,
    })
  })

  it('rejects mutable names for irreversible remove before socket I/O', async () => {
    let requests = 0
    const server = await fixture((_request, response) => {
      requests += 1
      response.writeHead(500)
      response.end()
    })
    const transport = makeNodeDockerEngineOwnedObjectTransport({ socketPath: server.socketPath })

    await expect(transport.removeContainer('owned-by-name')).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_REQUEST_INVALID',
    })
    await expect(transport.removeNetwork('owned-by-name')).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_REQUEST_INVALID',
    })
    await expect(transport.removeContainer('A'.repeat(64))).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_REQUEST_INVALID',
    })
    expect(requests).toBe(0)
  })

  it('inspects and removes networks through exact versioned paths', async () => {
    const observed: Array<Readonly<{ method?: string; url?: string }>> = []
    const server = await fixture((request, response) => {
      observed.push({
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.url === undefined ? {} : { url: request.url }),
      })
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ Id: NETWORK_ID, Name: 'aisy-network' }))
        return
      }
      response.writeHead(204)
      response.end()
    })
    const transport = makeNodeDockerEngineOwnedObjectTransport({ socketPath: server.socketPath })

    await expect(transport.inspectNetwork('aisy-network')).resolves.toEqual({
      outcome: 'found',
      statusCode: 200,
      document: { Id: NETWORK_ID, Name: 'aisy-network' },
    })
    await expect(transport.removeNetwork(NETWORK_ID)).resolves.toEqual({
      outcome: 'removed',
      statusCode: 204,
    })
    expect(observed).toEqual([
      { method: 'GET', url: '/v1.54/networks/aisy-network' },
      { method: 'DELETE', url: `/v1.54/networks/${NETWORK_ID}` },
    ])
  })

  it('returns typed network object-not-found for inspect and remove', async () => {
    const server = await fixture((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"message":"not used for classification"}')
    })
    const transport = makeNodeDockerEngineOwnedObjectTransport({ socketPath: server.socketPath })

    await expect(transport.inspectNetwork('missing-network')).resolves.toEqual({
      outcome: 'not-found',
      statusCode: 404,
    })
    await expect(transport.removeNetwork(NETWORK_ID)).resolves.toEqual({
      outcome: 'not-found',
      statusCode: 404,
    })
  })

  it('rejects TCP, environment-style and malformed endpoint inputs', () => {
    for (const socketPath of [
      'tcp://127.0.0.1:2375',
      'unix:///var/run/docker.sock',
      'docker.sock',
      '/var/run/../run/docker.sock',
      '/',
    ]) {
      expect(() => makeNodeDockerEngineOwnedObjectTransport({ socketPath })).toThrowError(
        new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_ENDPOINT_INVALID'),
      )
    }
  })

  it('rejects arbitrary paths instead of exposing a generic Engine API', async () => {
    const transport = makeNodeDockerEngineOwnedObjectTransport({
      socketPath: join(tmpdir(), 'aisy-unused-engine.sock'),
    })

    await expect(transport.inspectContainer('../images/json')).rejects.toMatchObject({
      code: 'DOCKER_ENGINE_REQUEST_INVALID',
    })
  })
})

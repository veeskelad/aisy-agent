import { request, type ClientRequest, type IncomingMessage } from 'node:http'
import { isAbsolute, normalize } from 'node:path'

export const DOCKER_ENGINE_API_VERSION = 'v1.54' as const

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024
const DEFAULT_MAX_JSON_NODES = 4_096
const MAX_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_JSON_NODES = 16_384
const MAX_JSON_DEPTH = 64
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024
const MAX_RESPONSE_HEADERS = 64
const OBJECT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const IMMUTABLE_OBJECT_ID = /^[a-f0-9]{64}$/

export type DockerEngineOwnedObjectTransportErrorCode =
  | 'DOCKER_ENGINE_ENDPOINT_INVALID'
  | 'DOCKER_ENGINE_REQUEST_INVALID'
  | 'DOCKER_ENGINE_ABORTED'
  | 'DOCKER_ENGINE_TIMEOUT'
  | 'DOCKER_ENGINE_RESPONSE_TOO_LARGE'
  | 'DOCKER_ENGINE_RESPONSE_TOO_COMPLEX'
  | 'DOCKER_ENGINE_RESPONSE_INVALID'
  | 'DOCKER_ENGINE_HTTP_STATUS'
  | 'DOCKER_ENGINE_TRANSPORT_FAILED'

export class DockerEngineOwnedObjectTransportError extends Error {
  constructor(
    public readonly code: DockerEngineOwnedObjectTransportErrorCode,
    public readonly statusCode: number | null = null,
  ) {
    super(code)
    this.name = 'DockerEngineOwnedObjectTransportError'
  }
}

export type DockerEngineJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DockerEngineJsonValue[]
  | DockerEngineJsonObject

export type DockerEngineJsonObject = Readonly<{
  [key: string]: DockerEngineJsonValue
}>

export type DockerEngineInspectResult =
  | Readonly<{
    outcome: 'found'
    statusCode: 200
    document: DockerEngineJsonObject
  }>
  | Readonly<{
    outcome: 'not-found'
    statusCode: 404
  }>

export type DockerEngineRemoveResult =
  | Readonly<{
    outcome: 'removed'
    statusCode: 204
  }>
  | Readonly<{
    outcome: 'not-found'
    statusCode: 404
  }>

export interface DockerEngineOwnedObjectTransport {
  inspectContainer(
    container: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DockerEngineInspectResult>
  removeContainer(
    immutableContainerId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DockerEngineRemoveResult>
  inspectNetwork(
    network: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DockerEngineInspectResult>
  removeNetwork(
    immutableNetworkId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<DockerEngineRemoveResult>
}

export interface NodeDockerEngineOwnedObjectTransportOptions {
  readonly socketPath: string
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxJsonNodes?: number
}

interface RawResponse {
  readonly statusCode: number
  readonly headers: IncomingMessage['headers']
  readonly body: Buffer
}

interface TransportPolicy {
  readonly socketPath: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly maxJsonNodes: number
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number | null {
  const candidate = value ?? fallback
  return Number.isSafeInteger(candidate) && candidate > 0 && candidate <= maximum
    ? candidate
    : null
}

function makePolicy(options: NodeDockerEngineOwnedObjectTransportOptions): TransportPolicy {
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
  )
  const maxJsonNodes = boundedInteger(
    options.maxJsonNodes,
    DEFAULT_MAX_JSON_NODES,
    MAX_JSON_NODES,
  )
  if (!isAbsolute(options.socketPath) || normalize(options.socketPath) !== options.socketPath ||
    options.socketPath.endsWith('/') || options.socketPath.includes('\0') ||
    timeoutMs === null || maxResponseBytes === null || maxJsonNodes === null) {
    throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_ENDPOINT_INVALID')
  }
  return Object.freeze({
    socketPath: options.socketPath,
    timeoutMs,
    maxResponseBytes,
    maxJsonNodes,
  })
}

function objectPath(kind: 'containers' | 'networks', reference: string): string {
  if (!OBJECT_REFERENCE.test(reference)) {
    throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_REQUEST_INVALID')
  }
  return `/${kind}/${encodeURIComponent(reference)}`
}

function immutableObjectPath(kind: 'containers' | 'networks', id: string): string {
  if (!IMMUTABLE_OBJECT_ID.test(id)) {
    throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_REQUEST_INVALID')
  }
  return `/${kind}/${id}`
}

function responseContentLength(response: IncomingMessage): number | null {
  const raw = response.headers['content-length']
  if (raw === undefined) return null
  if (!/^\d+$/.test(raw)) {
    throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_RESPONSE_INVALID')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_RESPONSE_INVALID')
  }
  return value
}

function exchange(
  policy: TransportPolicy,
  method: 'GET' | 'DELETE',
  path: string,
  signal: AbortSignal | undefined,
): Promise<RawResponse> {
  if (signal?.aborted === true) {
    return Promise.reject(new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_ABORTED'))
  }
  return new Promise<RawResponse>((resolve, reject) => {
    let clientRequest: ClientRequest | null = null
    let settled = false
    let timedOut = false
    let aborted = false

    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: DockerEngineOwnedObjectTransportError): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAbort = (): void => {
      aborted = true
      fail(new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_ABORTED'))
      clientRequest?.destroy()
    }
    const timer = setTimeout(() => {
      timedOut = true
      fail(new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_TIMEOUT'))
      clientRequest?.destroy()
    }, policy.timeoutMs)
    timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) {
      onAbort()
      return
    }

    try {
      clientRequest = request({
        method,
        socketPath: policy.socketPath,
        path: `/${DOCKER_ENGINE_API_VERSION}${path}`,
        agent: false,
        maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
        headers: {
          accept: 'application/json',
          connection: 'close',
        },
      }, response => {
        let responseLength: number | null
        try {
          responseLength = responseContentLength(response)
        } catch (error) {
          fail(error as DockerEngineOwnedObjectTransportError)
          response.destroy()
          return
        }
        if (responseLength !== null && responseLength > policy.maxResponseBytes) {
          fail(new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_RESPONSE_TOO_LARGE'))
          response.destroy()
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        response.on('data', (chunk: Buffer | string) => {
          if (settled) return
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          received += bytes.byteLength
          if (received > policy.maxResponseBytes) {
            fail(new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_RESPONSE_TOO_LARGE'))
            response.destroy()
            clientRequest?.destroy()
            return
          }
          chunks.push(bytes)
        })
        response.once('aborted', () => {
          fail(new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_TRANSPORT_FAILED'))
        })
        response.once('error', () => {
          fail(new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_TRANSPORT_FAILED'))
        })
        response.once('end', () => {
          if (settled) return
          const statusCode = response.statusCode
          if (statusCode === undefined) {
            fail(new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_RESPONSE_INVALID'))
            return
          }
          settled = true
          cleanup()
          resolve(Object.freeze({
            statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks, received),
          }))
        })
      })
      clientRequest.maxHeadersCount = MAX_RESPONSE_HEADERS
      clientRequest.once('error', () => {
        if (settled) return
        fail(new DockerEngineOwnedObjectTransportError(
          aborted
            ? 'DOCKER_ENGINE_ABORTED'
            : timedOut
              ? 'DOCKER_ENGINE_TIMEOUT'
              : 'DOCKER_ENGINE_TRANSPORT_FAILED',
        ))
      })
      clientRequest.end()
    } catch {
      fail(new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_TRANSPORT_FAILED'))
      clientRequest?.destroy()
    }
  })
}

function isJsonResponse(response: RawResponse): boolean {
  const contentType = response.headers['content-type']
  return typeof contentType === 'string' &&
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function parseBoundedObject(response: RawResponse, maxNodes: number): DockerEngineJsonObject {
  if (!isJsonResponse(response)) {
    throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_RESPONSE_INVALID')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body.toString('utf8'))
  } catch {
    throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_RESPONSE_INVALID')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_RESPONSE_INVALID')
  }
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [{ value: parsed, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    nodes += 1
    if (nodes > maxNodes || current.depth > MAX_JSON_DEPTH) {
      throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_RESPONSE_TOO_COMPLEX')
    }
    if (current.value !== null && typeof current.value === 'object') {
      const children = Array.isArray(current.value)
        ? current.value
        : Object.values(current.value as Record<string, unknown>)
      if (children.length + pending.length > maxNodes - nodes) {
        throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_RESPONSE_TOO_COMPLEX')
      }
      for (const value of children) pending.push({ value, depth: current.depth + 1 })
      Object.freeze(current.value)
    }
  }
  return Object.freeze(parsed as DockerEngineJsonObject)
}

function httpStatus(statusCode: number): never {
  throw new DockerEngineOwnedObjectTransportError('DOCKER_ENGINE_HTTP_STATUS', statusCode)
}

export function makeNodeDockerEngineOwnedObjectTransport(
  options: NodeDockerEngineOwnedObjectTransportOptions,
): DockerEngineOwnedObjectTransport {
  const policy = makePolicy(options)
  return Object.freeze<DockerEngineOwnedObjectTransport>({
    async inspectContainer(container, requestOptions) {
      const response = await exchange(
        policy,
        'GET',
        `${objectPath('containers', container)}/json`,
        requestOptions?.signal,
      )
      if (response.statusCode === 404) {
        return Object.freeze({ outcome: 'not-found' as const, statusCode: 404 as const })
      }
      if (response.statusCode !== 200) httpStatus(response.statusCode)
      return Object.freeze({
        outcome: 'found' as const,
        statusCode: 200 as const,
        document: parseBoundedObject(response, policy.maxJsonNodes),
      })
    },

    async removeContainer(immutableContainerId, requestOptions) {
      const response = await exchange(
        policy,
        'DELETE',
        `${immutableObjectPath('containers', immutableContainerId)}?force=1&v=1`,
        requestOptions?.signal,
      )
      if (response.statusCode === 404) {
        return Object.freeze({ outcome: 'not-found' as const, statusCode: 404 as const })
      }
      if (response.statusCode !== 204) httpStatus(response.statusCode)
      return Object.freeze({ outcome: 'removed' as const, statusCode: 204 as const })
    },

    async inspectNetwork(network, requestOptions) {
      const response = await exchange(
        policy,
        'GET',
        objectPath('networks', network),
        requestOptions?.signal,
      )
      if (response.statusCode === 404) {
        return Object.freeze({ outcome: 'not-found' as const, statusCode: 404 as const })
      }
      if (response.statusCode !== 200) httpStatus(response.statusCode)
      return Object.freeze({
        outcome: 'found' as const,
        statusCode: 200 as const,
        document: parseBoundedObject(response, policy.maxJsonNodes),
      })
    },

    async removeNetwork(immutableNetworkId, requestOptions) {
      const response = await exchange(
        policy,
        'DELETE',
        immutableObjectPath('networks', immutableNetworkId),
        requestOptions?.signal,
      )
      if (response.statusCode === 404) {
        return Object.freeze({ outcome: 'not-found' as const, statusCode: 404 as const })
      }
      if (response.statusCode !== 204) httpStatus(response.statusCode)
      return Object.freeze({ outcome: 'removed' as const, statusCode: 204 as const })
    },
  })
}

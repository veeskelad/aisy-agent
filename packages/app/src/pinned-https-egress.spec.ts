import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isPublicEgressAddress,
  makeNodePinnedHttpsTransport,
  makePinnedHttpsTextGet,
  pinnedWebSearchUrl,
  PinnedHttpsEgressError,
  type PinnedAddress,
  type PinnedHttpsRequest,
  type PinnedHttpsResponse,
  type PinnedHttpsTransport,
} from './pinned-https-egress.js'

const publicAddress = Object.freeze({ address: '93.184.216.34', family: 4 as const })
type RequestFactory = NonNullable<
  NonNullable<Parameters<typeof makeNodePinnedHttpsTransport>[0]>['request']
>

function response(overrides: Partial<PinnedHttpsResponse> = {}): PinnedHttpsResponse {
  return Object.freeze({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: new TextEncoder().encode('<html>ok</html>'),
    ...overrides,
  })
}

function harness(overrides: {
  addresses?: readonly PinnedAddress[]
  get?: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>
  timeoutMs?: number
  maxResponseBytes?: number
} = {}) {
  const requests: PinnedHttpsRequest[] = []
  const transport: PinnedHttpsTransport = {
    async get(request) {
      requests.push(request)
      return overrides.get?.(request) ?? response()
    },
  }
  const get = makePinnedHttpsTextGet({
    allowedHosts: ['html.duckduckgo.com'],
    resolve: async () => overrides.addresses ?? [publicAddress],
    transport,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: overrides.maxResponseBytes }),
  })
  return { get, requests }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('pinned HTTPS egress', () => {
  it.each([
    ['0.0.0.0', 4],
    ['10.1.2.3', 4],
    ['100.64.0.1', 4],
    ['127.0.0.1', 4],
    ['169.254.1.1', 4],
    ['172.16.1.1', 4],
    ['192.168.1.1', 4],
    ['198.18.0.1', 4],
    ['203.0.113.1', 4],
    ['224.0.0.1', 4],
    ['::', 6],
    ['::1', 6],
    ['::ffff:127.0.0.1', 6],
    ['2001::1', 6],
    ['2002:7f00:1::', 6],
    ['3fff::1', 6],
    ['fc00::1', 6],
    ['fe80::1', 6],
    ['ff02::1', 6],
  ] as const)('denies non-public address %s', (address, family) => {
    expect(isPublicEgressAddress(address, family)).toBe(false)
  })

  it('accepts ordinary public IPv4 and IPv6 addresses', () => {
    expect(isPublicEgressAddress('93.184.216.34', 4)).toBe(true)
    expect(isPublicEgressAddress('2606:4700:4700::1111', 6)).toBe(true)
  })

  it('builds only a bounded encoded search URL', () => {
    expect(pinnedWebSearchUrl('Aisy agent & memory'))
      .toBe('https://html.duckduckgo.com/html/?q=Aisy%20agent%20%26%20memory')
  })

  it.each([
    '',
    'line\nbreak',
    'api_key=secret-value-that-must-not-leave',
    'sk-proj_1234567890abcdefghijklmnop',
    '-----BEGIN PRIVATE KEY-----',
    'a'.repeat(64),
    'я'.repeat(300),
  ])('rejects unsafe search text before URL or DNS: %s', (query) => {
    expect(() => pinnedWebSearchUrl(query)).toThrow(
      new PinnedHttpsEgressError('EGRESS_QUERY_DENIED'),
    )
  })

  it.each([
    'http://html.duckduckgo.com/html?q=aisy',
    'https://example.com/html?q=aisy',
    'https://user:pass@html.duckduckgo.com/html?q=aisy',
    'https://html.duckduckgo.com:444/html?q=aisy',
    'https://html.duckduckgo.com/html?q=aisy#fragment',
  ])('rejects denied URL before DNS or transport: %s', async (url) => {
    const resolve = vi.fn(async () => [publicAddress])
    const transport = { get: vi.fn(async () => response()) }
    const get = makePinnedHttpsTextGet({
      allowedHosts: ['html.duckduckgo.com'],
      resolve,
      transport,
    })

    await expect(get(url)).rejects.toEqual(new PinnedHttpsEgressError('EGRESS_URL_DENIED'))
    expect(resolve).not.toHaveBeenCalled()
    expect(transport.get).not.toHaveBeenCalled()
  })

  it('rejects any private or malformed DNS answer before transport', async () => {
    const h = harness({
      addresses: [publicAddress, { address: '127.0.0.1', family: 4 }],
    })

    await expect(h.get('https://html.duckduckgo.com/html?q=aisy'))
      .rejects.toEqual(new PinnedHttpsEgressError('EGRESS_ADDRESS_DENIED'))
    expect(h.requests).toHaveLength(0)
  })

  it('pins the selected IP while preserving the TLS hostname and exact path', async () => {
    const h = harness()

    await expect(h.get('https://html.duckduckgo.com/html/?q=aisy%20agent'))
      .resolves.toBe('<html>ok</html>')
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({
      hostname: 'html.duckduckgo.com',
      servername: 'html.duckduckgo.com',
      address: '93.184.216.34',
      family: 4,
      path: '/html/?q=aisy%20agent',
      timeoutMs: 15_000,
      maxResponseBytes: 2 * 1024 * 1024,
    })
  })

  it.each([
    ['redirect', response({ status: 302 })],
    ['non-html', response({ contentType: 'application/json' })],
    ['invalid UTF-8', response({ body: new Uint8Array([0xff]) })],
  ])('denies %s without a retry', async (_name, denied) => {
    const get = vi.fn(async () => denied)
    const h = harness({ get })

    await expect(h.get('https://html.duckduckgo.com/html?q=aisy'))
      .rejects.toBeInstanceOf(PinnedHttpsEgressError)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('rechecks the response bound even when a transport violates its contract', async () => {
    const h = harness({
      maxResponseBytes: 1024,
      get: async () => response({ body: new Uint8Array(1025) }),
    })

    await expect(h.get('https://html.duckduckgo.com/html?q=aisy'))
      .rejects.toEqual(new PinnedHttpsEgressError('EGRESS_RESPONSE_TOO_LARGE'))
  })

  it('rejects mutable or accessor-backed transport responses without invoking getters', async () => {
    const getter = vi.fn(() => new TextEncoder().encode('<html>unsafe</html>'))
    const accessorResponse = Object.defineProperty({
      status: 200,
      contentType: 'text/html',
    }, 'body', { enumerable: true, get: getter })
    const proxyResponse = new Proxy(response(), {})
    class BodySubclass extends Uint8Array {}
    const subclassResponse = {
      status: 200,
      contentType: 'text/html',
      body: new BodySubclass(16),
    }

    for (const denied of [accessorResponse, proxyResponse, subclassResponse]) {
      const h = harness({
        get: async () => denied as unknown as PinnedHttpsResponse,
      })
      await expect(h.get('https://html.duckduckgo.com/html?q=aisy'))
        .rejects.toEqual(new PinnedHttpsEgressError('EGRESS_RESPONSE_INVALID'))
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('owns the total deadline and does not return while transport is pending', async () => {
    vi.useFakeTimers()
    const h = harness({
      timeoutMs: 1_000,
      get: (request) => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          reject(new PinnedHttpsEgressError('EGRESS_TIMEOUT'))
        }, { once: true })
      }),
    })
    const pending = h.get('https://html.duckduckgo.com/html?q=aisy')
    const rejected = expect(pending).rejects.toEqual(
      new PinnedHttpsEgressError('EGRESS_TIMEOUT'),
    )
    await vi.advanceTimersByTimeAsync(1_000)

    await rejected
  })

  it('includes DNS resolution in the same total deadline', async () => {
    vi.useFakeTimers()
    let aborted = false
    const resolve = (_hostname: string, signal: AbortSignal) =>
      new Promise<readonly PinnedAddress[]>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true
          reject(new PinnedHttpsEgressError('EGRESS_TIMEOUT'))
        }, { once: true })
      })
    const transport = { get: vi.fn(async () => response()) }
    const get = makePinnedHttpsTextGet({
      allowedHosts: ['html.duckduckgo.com'],
      timeoutMs: 1_000,
      resolve,
      transport,
    })
    const pending = get('https://html.duckduckgo.com/html?q=aisy')
    const rejected = expect(pending).rejects.toEqual(
      new PinnedHttpsEgressError('EGRESS_TIMEOUT'),
    )
    await vi.advanceTimersByTimeAsync(1_000)

    await rejected
    expect(aborted).toBe(true)
    expect(transport.get).not.toHaveBeenCalled()
  })

  it('the Node transport uses one pinned lookup and rejects another remote address', async () => {
    const socket = Object.assign(new EventEmitter(), {
      remoteAddress: '93.184.216.35',
      remoteFamily: 'IPv4',
    })
    const requestHandle = Object.assign(new EventEmitter(), {
      destroyed: false,
      setTimeout: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(function (this: { destroyed: boolean }) { this.destroyed = true }),
    })
    let captured: Record<string, unknown> | null = null
    const request = vi.fn((options: Record<string, unknown>) => {
      captured = options
      queueMicrotask(() => {
        requestHandle.emit('socket', socket)
        socket.emit('secureConnect')
      })
      return requestHandle
    })
    const transport = makeNodePinnedHttpsTransport({
      request: request as unknown as RequestFactory,
    })
    const descriptor: PinnedHttpsRequest = {
      hostname: 'html.duckduckgo.com',
      servername: 'html.duckduckgo.com',
      path: '/html?q=aisy',
      address: publicAddress.address,
      family: publicAddress.family,
      timeoutMs: 15_000,
      maxResponseBytes: 1024,
      userAgent: 'aisy-agent',
      signal: new AbortController().signal,
    }

    await expect(transport.get(descriptor)).rejects.toEqual(
      new PinnedHttpsEgressError('EGRESS_REMOTE_ADDRESS_MISMATCH'),
    )
    expect(captured).toMatchObject({
      protocol: 'https:',
      hostname: 'html.duckduckgo.com',
      servername: 'html.duckduckgo.com',
      port: 443,
      method: 'GET',
      path: '/html?q=aisy',
      agent: false,
      rejectUnauthorized: true,
      maxHeaderSize: 32 * 1024,
    })
    expect(requestHandle.destroy).toHaveBeenCalled()
  })

  it('the Node transport bounds streamed bytes before returning a body', async () => {
    const socket = Object.assign(new EventEmitter(), {
      remoteAddress: publicAddress.address,
      remoteFamily: 'IPv4',
    })
    const requestHandle = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    })
    const responseStream = Object.assign(new PassThrough(), {
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
    })
    const request = vi.fn((_options: unknown, callback: (value: typeof responseStream) => void) => {
      queueMicrotask(() => {
        requestHandle.emit('socket', socket)
        socket.emit('secureConnect')
        callback(responseStream)
        responseStream.end(Buffer.alloc(1025))
      })
      return requestHandle
    })
    const transport = makeNodePinnedHttpsTransport({
      request: request as unknown as RequestFactory,
    })

    await expect(transport.get({
      hostname: 'html.duckduckgo.com',
      servername: 'html.duckduckgo.com',
      path: '/html?q=aisy',
      address: publicAddress.address,
      family: publicAddress.family,
      timeoutMs: 15_000,
      maxResponseBytes: 1024,
      userAgent: 'aisy-agent',
      signal: new AbortController().signal,
    })).rejects.toEqual(new PinnedHttpsEgressError('EGRESS_RESPONSE_TOO_LARGE'))
    expect(responseStream.destroyed).toBe(true)
  })

  it('the Node transport settles its timeout without waiting for an error event', async () => {
    let timeout: (() => void) | null = null
    const requestHandle = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn((_ms: number, callback: () => void) => { timeout = callback }),
      end: vi.fn(),
      destroy: vi.fn(),
    })
    const request = vi.fn(() => requestHandle)
    const transport = makeNodePinnedHttpsTransport({
      request: request as unknown as RequestFactory,
    })
    const pending = transport.get({
      hostname: 'html.duckduckgo.com',
      servername: 'html.duckduckgo.com',
      path: '/html?q=aisy',
      address: publicAddress.address,
      family: publicAddress.family,
      timeoutMs: 15_000,
      maxResponseBytes: 1024,
      userAgent: 'aisy-agent',
      signal: new AbortController().signal,
    })
    const rejected = expect(pending).rejects.toEqual(
      new PinnedHttpsEgressError('EGRESS_TIMEOUT'),
    )
    expect(timeout).not.toBeNull()
    ;(timeout as unknown as () => void)()

    await rejected
    expect(requestHandle.destroy).toHaveBeenCalledOnce()
  })

  it('the Node transport rejects a closed request instead of hanging', async () => {
    const requestHandle = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      end: vi.fn(function (this: EventEmitter) { queueMicrotask(() => this.emit('close')) }),
      destroy: vi.fn(),
    })
    const transport = makeNodePinnedHttpsTransport({
      request: vi.fn(() => requestHandle) as unknown as RequestFactory,
    })

    await expect(transport.get({
      hostname: 'html.duckduckgo.com',
      servername: 'html.duckduckgo.com',
      path: '/html?q=aisy',
      address: publicAddress.address,
      family: publicAddress.family,
      timeoutMs: 15_000,
      maxResponseBytes: 1024,
      userAgent: 'aisy-agent',
      signal: new AbortController().signal,
    })).rejects.toEqual(new PinnedHttpsEgressError('EGRESS_TRANSPORT_FAILED'))
  })
})

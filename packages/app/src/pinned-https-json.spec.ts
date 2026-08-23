// A service API through the same gauntlet.
//
// `makePinnedHttpsTextGet` could only issue a bare GET for HTML, so every
// service in the key catalogue — Serper, Apify, Supadata — was unreachable: all
// three need a method, an Authorization header, and a body. This adds exactly
// that and nothing else: the DNS pinning, the private-range refusal, the size
// cap and the deadline are the same code they always were.
//
// The one new rule is where a credential may live. It travels in a header,
// never in the URL — a query string ends up in access logs at the far end, and
// this module already refuses secret-shaped queries outright.

import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import {
  checkedEgressHeaders,
  makeNodePinnedHttpsTransport,
  makePinnedHttpsJson,
  MAX_EGRESS_BODY_BYTES,
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

function jsonResponse(overrides: Partial<PinnedHttpsResponse> = {}): PinnedHttpsResponse {
  return Object.freeze({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: new TextEncoder().encode('{"organic":[{"title":"Aisy"}]}'),
    ...overrides,
  })
}

function harness(overrides: {
  addresses?: readonly PinnedAddress[]
  get?: (request: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>
} = {}) {
  const requests: PinnedHttpsRequest[] = []
  const transport: PinnedHttpsTransport = {
    async get(request) {
      requests.push(request)
      return overrides.get?.(request) ?? jsonResponse()
    },
  }
  const call = makePinnedHttpsJson({
    allowedHosts: ['google.serper.dev', 'api.supadata.ai'],
    resolve: async () => overrides.addresses ?? [publicAddress],
    transport,
  })
  return { call, requests }
}

describe('a JSON call through the pinned egress', () => {
  it('carries the method, the credential header and the body to the transport', async () => {
    const h = harness()

    const answer = await h.call({
      url: 'https://google.serper.dev/search',
      method: 'POST',
      headers: { 'X-API-KEY': 'service-key-value' },
      body: JSON.stringify({ q: 'aisy harness' }),
    })

    expect(answer).toEqual({ organic: [{ title: 'Aisy' }] })
    const sent = h.requests[0]!
    expect(sent.method).toBe('POST')
    expect(sent.body).toBe('{"q":"aisy harness"}')
    // Header names are normalised by the transport, and the JSON defaults are
    // filled in — the caller only had to name the credential.
    expect(sent.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
      'X-API-KEY': 'service-key-value',
    })
    // The URL is exactly what was asked for: nothing appended, no key smuggled.
    expect(sent.path).toBe('/search')
  })

  it('defaults to GET with no body for a service that reads', async () => {
    const h = harness()

    await h.call({
      url: 'https://api.supadata.ai/v1/transcript?url=https%3A%2F%2Fyoutu.be%2Fabc',
      headers: { 'x-api-key': 'k' },
    })

    const sent = h.requests[0]!
    expect(sent.method).toBe('GET')
    expect(sent.body).toBeUndefined()
    expect(sent.path).toBe('/v1/transcript?url=https%3A%2F%2Fyoutu.be%2Fabc')
  })

  it.each([
    ['http instead of https', 'http://google.serper.dev/search'],
    ['a host nobody allowed', 'https://evil.example.com/search'],
    ['credentials in the URL', 'https://user:pass@google.serper.dev/search'],
    ['an explicit port', 'https://google.serper.dev:8443/search'],
  ])('refuses %s before DNS or transport', async (_case, url) => {
    const h = harness()

    await expect(h.call({ url })).rejects.toEqual(
      new PinnedHttpsEgressError('EGRESS_URL_DENIED'),
    )
    expect(h.requests).toHaveLength(0)
  })

  it('refuses a credential that was put in the query instead of a header', async () => {
    const h = harness()

    await expect(h.call({
      url: 'https://google.serper.dev/search?api_key=sk-abcdefghijklmnopqrstuvwx',
    })).rejects.toEqual(new PinnedHttpsEgressError('EGRESS_QUERY_DENIED'))
    expect(h.requests).toHaveLength(0)
  })

  it('refuses an answer that is not JSON, and one that is not parseable', async () => {
    const html = harness({ get: async () => jsonResponse({ contentType: 'text/html' }) })
    await expect(html.call({ url: 'https://google.serper.dev/search' }))
      .rejects.toEqual(new PinnedHttpsEgressError('EGRESS_RESPONSE_DENIED'))

    const broken = harness({
      get: async () => jsonResponse({ body: new TextEncoder().encode('{"organic":') }),
    })
    await expect(broken.call({ url: 'https://google.serper.dev/search' }))
      .rejects.toEqual(new PinnedHttpsEgressError('EGRESS_RESPONSE_INVALID'))
  })

  it('refuses a private address the service resolved to', async () => {
    const h = harness({ addresses: [{ address: '127.0.0.1', family: 4 }] })

    await expect(h.call({ url: 'https://google.serper.dev/search' }))
      .rejects.toEqual(new PinnedHttpsEgressError('EGRESS_ADDRESS_DENIED'))
  })

  it('does not chase a redirect: an API answering 3xx is broken, not moved', async () => {
    const h = harness({
      get: async () => jsonResponse({ status: 302, location: 'https://elsewhere.example.com/' }),
    })

    await expect(h.call({ url: 'https://google.serper.dev/search' }))
      .rejects.toEqual(new PinnedHttpsEgressError('EGRESS_RESPONSE_DENIED'))
    expect(h.requests).toHaveLength(1)
  })
})

describe('the headers this egress agrees to send', () => {
  it('accepts the four names a service API needs, lowercased', () => {
    expect(checkedEgressHeaders({
      Authorization: 'Bearer t', 'X-API-KEY': 'k', 'Content-Type': 'application/json',
    })).toEqual({ authorization: 'Bearer t', 'x-api-key': 'k', 'content-type': 'application/json' })
    expect(checkedEgressHeaders(undefined)).toEqual({})
  })

  it.each([
    ['a name nobody allowed', { cookie: 'session=1' }],
    ['a header that would rewrite the identity', { 'user-agent': 'curl' }],
    ['a value carrying CRLF — request splitting', { authorization: 'Bearer t\r\nX-Evil: 1' }],
    ['a value carrying a bare newline', { 'x-api-key': 'k\nmore' }],
    ['an empty value', { authorization: '' }],
    ['a non-string value', { authorization: 42 }],
    ['a list instead of a record', ['authorization']],
  ])('refuses %s', (_case, headers) => {
    expect(() => checkedEgressHeaders(headers)).toThrow(PinnedHttpsEgressError)
  })
})

describe('the Node transport with a body', () => {
  function fakeRequest() {
    const socket = Object.assign(new EventEmitter(), {
      remoteAddress: publicAddress.address,
      remoteFamily: 'IPv4',
    })
    const handle = Object.assign(new EventEmitter(), {
      destroyed: false,
      setTimeout: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(function (this: { destroyed: boolean }) { this.destroyed = true }),
    })
    let captured: Record<string, unknown> | null = null
    const request = vi.fn((options: Record<string, unknown>) => {
      captured = options
      queueMicrotask(() => {
        handle.emit('socket', socket)
        socket.emit('secureConnect')
        // Nothing answers; the test only inspects what was about to be sent.
        handle.emit('close')
      })
      return handle
    })
    return { handle, request, options: () => captured }
  }

  const descriptor = (overrides: Partial<PinnedHttpsRequest> = {}): PinnedHttpsRequest => ({
    hostname: 'google.serper.dev',
    servername: 'google.serper.dev',
    path: '/search',
    address: publicAddress.address,
    family: publicAddress.family,
    timeoutMs: 15_000,
    maxResponseBytes: 1024,
    userAgent: 'aisy-agent',
    signal: new AbortController().signal,
    ...overrides,
  })

  it('sends the body with a content-length and the caller’s headers', async () => {
    const fake = fakeRequest()
    const transport = makeNodePinnedHttpsTransport({
      request: fake.request as unknown as RequestFactory,
    })

    await expect(transport.get(descriptor({
      method: 'POST',
      headers: { 'x-api-key': 'k' },
      body: '{"q":"тест"}',
    }))).rejects.toThrow(PinnedHttpsEgressError)

    expect(fake.options()).toMatchObject({ method: 'POST' })
    const headers = (fake.options() as { headers: Record<string, string> }).headers
    expect(headers['x-api-key']).toBe('k')
    // Cyrillic is two bytes per letter: a character count here would truncate
    // the body at the far end.
    expect(headers['content-length']).toBe(String(Buffer.byteLength('{"q":"тест"}', 'utf8')))
    expect(fake.handle.end).toHaveBeenCalledWith('{"q":"тест"}', 'utf8')
  })

  it.each([
    ['a body without POST', { body: '{}' }],
    ['a body over the cap', { method: 'POST' as const, body: 'x'.repeat(MAX_EGRESS_BODY_BYTES + 1) }],
    ['a header off the allowlist', { headers: { cookie: 'a=1' } }],
    ['a method this egress does not speak', { method: 'DELETE' as unknown as 'POST' }],
  ])('refuses %s before opening a socket', async (_case, overrides) => {
    const fake = fakeRequest()
    const transport = makeNodePinnedHttpsTransport({
      request: fake.request as unknown as RequestFactory,
    })

    await expect(transport.get(descriptor(overrides))).rejects.toEqual(
      new PinnedHttpsEgressError('INVALID_EGRESS_CONFIG'),
    )
    expect(fake.request).not.toHaveBeenCalled()
  })
})

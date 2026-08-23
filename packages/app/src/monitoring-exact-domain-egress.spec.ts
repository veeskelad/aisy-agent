import { describe, expect, it, vi } from 'vitest'

import { makeMonitoringExactDomainHttpPort } from './monitoring-exact-domain-egress.js'
import {
  PinnedHttpsEgressError,
  type PinnedHttpsRequest,
  type PinnedHttpsResponse,
} from './pinned-https-egress.js'

const PUBLIC = Object.freeze({ address: '93.184.216.34', family: 4 as const })

function response(overrides: Partial<PinnedHttpsResponse> = {}): PinnedHttpsResponse {
  return Object.freeze({
    status: 200,
    contentType: 'application/rss+xml; charset=utf-8',
    body: new TextEncoder().encode('<rss>ok</rss>'),
    ...overrides,
  })
}

function request(url = 'https://feeds.example.com/releases.xml') {
  return { sourceId: 'source-a', url, maxBytes: 2_000_000 }
}

describe('monitoring exact-domain HTTPS egress', () => {
  it('pins public DNS and permits GET only for the source exact domain', async () => {
    const requests: PinnedHttpsRequest[] = []
    const port = makeMonitoringExactDomainHttpPort({
      authority: { getSourceEgressDomain: () => 'feeds.example.com' },
      resolve: async hostname => {
        expect(hostname).toBe('feeds.example.com')
        return [PUBLIC]
      },
      transport: { get: async descriptor => { requests.push(descriptor); return response() } },
    })

    await expect(port.get(request())).resolves.toEqual({
      status: 200,
      body: '<rss>ok</rss>',
      finalUrl: 'https://feeds.example.com/releases.xml',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      hostname: 'feeds.example.com', servername: 'feeds.example.com',
      address: PUBLIC.address, family: 4, path: '/releases.xml',
    })
  })

  it.each([
    ['unknown source', 'https://feeds.example.com/releases.xml', null],
    ['sibling subdomain', 'https://cdn.feeds.example.com/releases.xml', 'feeds.example.com'],
    ['parent domain', 'https://example.com/releases.xml', 'feeds.example.com'],
    ['plaintext', 'http://feeds.example.com/releases.xml', 'feeds.example.com'],
    ['credentials', 'https://user:pass@feeds.example.com/releases.xml', 'feeds.example.com'],
    ['secret query', 'https://feeds.example.com/releases.xml?api_key=must-not-leave', 'feeds.example.com'],
    ['non-443 port', 'https://feeds.example.com:444/releases.xml', 'feeds.example.com'],
  ])('denies %s before DNS or transport', async (_case, url, domain) => {
    const resolve = vi.fn(async () => [PUBLIC])
    const get = vi.fn(async () => response())
    const port = makeMonitoringExactDomainHttpPort({
      authority: { getSourceEgressDomain: () => domain },
      resolve,
      transport: { get },
    })

    await expect(port.get(request(url))).rejects.toEqual(
      new PinnedHttpsEgressError('EGRESS_URL_DENIED'),
    )
    expect(resolve).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('revalidates a same-domain redirect and refuses a cross-domain redirect before its I/O', async () => {
    const sameRequests: string[] = []
    const same = makeMonitoringExactDomainHttpPort({
      authority: { getSourceEgressDomain: () => 'feeds.example.com' },
      resolve: async () => [PUBLIC],
      transport: {
        get: async descriptor => {
          sameRequests.push(descriptor.path)
          return sameRequests.length === 1
            ? response({ status: 302, contentType: '', body: new Uint8Array(), location: '/v2.xml' })
            : response()
        },
      },
    })
    await expect(same.get(request())).resolves.toMatchObject({
      finalUrl: 'https://feeds.example.com/v2.xml',
    })
    expect(sameRequests).toEqual(['/releases.xml', '/v2.xml'])

    const crossGet = vi.fn(async () => response({
      status: 302,
      contentType: '',
      body: new Uint8Array(),
      location: 'https://other.example.net/feed.xml',
    }))
    const cross = makeMonitoringExactDomainHttpPort({
      authority: { getSourceEgressDomain: () => 'feeds.example.com' },
      resolve: async () => [PUBLIC],
      transport: { get: crossGet },
    })
    await expect(cross.get(request())).rejects.toEqual(
      new PinnedHttpsEgressError('EGRESS_URL_DENIED'),
    )
    expect(crossGet).toHaveBeenCalledTimes(1)
  })

  it('fails closed if removal revokes authority while a response is in flight', async () => {
    let domain: string | null = 'feeds.example.com'
    const port = makeMonitoringExactDomainHttpPort({
      authority: { getSourceEgressDomain: () => domain },
      resolve: async () => [PUBLIC],
      transport: {
        get: async () => {
          domain = null
          return response()
        },
      },
    })

    await expect(port.get(request())).rejects.toEqual(
      new PinnedHttpsEgressError('EGRESS_URL_DENIED'),
    )
  })

  it('does not start transport if removal wins during DNS resolution', async () => {
    let domain: string | null = 'feeds.example.com'
    const get = vi.fn(async () => response())
    const port = makeMonitoringExactDomainHttpPort({
      authority: { getSourceEgressDomain: () => domain },
      resolve: async () => {
        domain = null
        return [PUBLIC]
      },
      transport: { get },
    })

    await expect(port.get(request())).rejects.toEqual(
      new PinnedHttpsEgressError('EGRESS_URL_DENIED'),
    )
    expect(get).not.toHaveBeenCalled()
  })

  it('rejects one private DNS answer and oversized or non-feed responses', async () => {
    const privatePort = makeMonitoringExactDomainHttpPort({
      authority: { getSourceEgressDomain: () => 'feeds.example.com' },
      resolve: async () => [PUBLIC, { address: '127.0.0.1', family: 4 }],
      transport: { get: vi.fn(async () => response()) },
    })
    await expect(privatePort.get(request())).rejects.toEqual(
      new PinnedHttpsEgressError('EGRESS_ADDRESS_DENIED'),
    )

    for (const denied of [
      response({ contentType: 'application/json' }),
      response({ body: new Uint8Array(2_000_001) }),
    ]) {
      const port = makeMonitoringExactDomainHttpPort({
        authority: { getSourceEgressDomain: () => 'feeds.example.com' },
        resolve: async () => [PUBLIC],
        transport: { get: async () => denied },
      })
      await expect(port.get(request())).rejects.toBeInstanceOf(PinnedHttpsEgressError)
    }
  })
})

// Every test here is about one question: can a link an operator pasted reach
// something it should not — the local network, a plain-text port, an endless
// body — or come back as something other than text.

import { describe, expect, it, vi } from 'vitest'

import { extractReadableText, makeOpenPageFetch } from './page-fetch.js'
import type { PinnedAddress, PinnedHttpsRequest, PinnedHttpsResponse } from './pinned-https-egress.js'

const PUBLIC: PinnedAddress[] = [{ address: '93.184.216.34', family: 4 }]

function page(html: string, contentType = 'text/html; charset=utf-8'): PinnedHttpsResponse {
  return { status: 200, contentType, body: new TextEncoder().encode(html) }
}

function fetcher(options: {
  responses?: PinnedHttpsResponse[]
  resolve?: (hostname: string) => Promise<readonly PinnedAddress[]>
  maxRedirects?: number
  maxResponseBytes?: number
} = {}) {
  const requests: PinnedHttpsRequest[] = []
  const queue = [...(options.responses ?? [page('<p>hello</p>')])]
  const fetchPage = makeOpenPageFetch({
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    resolve: async (hostname) =>
      options.resolve ? options.resolve(hostname) : PUBLIC,
    transport: {
      get: async (request) => {
        requests.push(request)
        const next = queue.shift()
        if (next === undefined) throw new Error('no response queued')
        return next
      },
    },
  })
  return { fetchPage, requests }
}

describe('fetching a page the operator named', () => {
  it('returns the page as text, pinned to the address it resolved', async () => {
    const { fetchPage, requests } = fetcher({
      responses: [page('<h1>Заголовок</h1><p>Тело страницы</p>')],
    })

    const result = await fetchPage('https://example.com/about')

    expect(result.text).toContain('Заголовок')
    expect(result.text).toContain('Тело страницы')
    expect(result.url).toBe('https://example.com/about')
    expect(requests[0]).toMatchObject({
      hostname: 'example.com', path: '/about', address: '93.184.216.34', servername: 'example.com',
    })
  })

  it.each([
    ['http://example.com', 'plain http'],
    ['https://user:pass@example.com', 'credentials in the url'],
    ['https://example.com:8443/x', 'an explicit port'],
    ['file:///etc/passwd', 'a non-http scheme'],
    ['https://192.168.0.1/', 'a bare address instead of a host'],
  ])('refuses %s (%s)', async (url) => {
    const { fetchPage, requests } = fetcher()

    await expect(fetchPage(url)).rejects.toMatchObject({ code: 'EGRESS_URL_DENIED' })
    expect(requests).toEqual([])
  })

  it('refuses a host that resolves into the private network', async () => {
    const { fetchPage, requests } = fetcher({
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    })

    await expect(fetchPage('https://internal.example.com'))
      .rejects.toMatchObject({ code: 'EGRESS_ADDRESS_DENIED' })
    // Refused before a single byte left the machine.
    expect(requests).toEqual([])
  })

  it('follows a redirect by running the whole gauntlet again', async () => {
    const { fetchPage, requests } = fetcher({
      responses: [
        { status: 301, contentType: '', body: new Uint8Array(), location: 'https://www.example.com/final' },
        page('<p>после переезда</p>'),
      ],
    })

    const result = await fetchPage('https://example.com/start')

    expect(result.text).toContain('после переезда')
    expect(result.url).toBe('https://www.example.com/final')
    expect(requests.map((request) => request.hostname)).toEqual(['example.com', 'www.example.com'])
  })

  it('refuses a redirect that leaves https, whatever the first host was', async () => {
    const { fetchPage } = fetcher({
      responses: [
        { status: 302, contentType: '', body: new Uint8Array(), location: 'http://example.com/insecure' },
      ],
    })

    await expect(fetchPage('https://example.com/start'))
      .rejects.toMatchObject({ code: 'EGRESS_URL_DENIED' })
  })

  it('refuses a redirect onto a host that resolves privately', async () => {
    const { fetchPage } = fetcher({
      responses: [
        { status: 302, contentType: '', body: new Uint8Array(), location: 'https://intranet.example.com/' },
      ],
      resolve: async (hostname) =>
        hostname === 'intranet.example.com' ? [{ address: '10.0.0.5', family: 4 }] : PUBLIC,
    })

    await expect(fetchPage('https://example.com/start'))
      .rejects.toMatchObject({ code: 'EGRESS_ADDRESS_DENIED' })
  })

  it('gives up on a chain that never lands', async () => {
    const hop = (n: number): PinnedHttpsResponse => ({
      status: 302, contentType: '', body: new Uint8Array(), location: `https://example.com/hop-${String(n)}`,
    })
    const { fetchPage } = fetcher({ responses: [hop(1), hop(2), hop(3), hop(4)], maxRedirects: 2 })

    await expect(fetchPage('https://example.com/start'))
      .rejects.toMatchObject({ code: 'EGRESS_RESPONSE_DENIED' })
  })

  it('breaks a redirect loop instead of walking it', async () => {
    const { fetchPage } = fetcher({
      responses: [
        { status: 302, contentType: '', body: new Uint8Array(), location: 'https://example.com/b' },
        { status: 302, contentType: '', body: new Uint8Array(), location: 'https://example.com/a' },
      ],
    })

    await expect(fetchPage('https://example.com/a'))
      .rejects.toMatchObject({ code: 'EGRESS_URL_DENIED' })
  })

  it('refuses anything that is not readable text', async () => {
    const { fetchPage } = fetcher({
      responses: [page('%PDF-1.7', 'application/pdf')],
    })

    await expect(fetchPage('https://example.com/manual.pdf'))
      .rejects.toMatchObject({ code: 'EGRESS_RESPONSE_DENIED' })
  })

  it('refuses a body larger than the ceiling', async () => {
    const { fetchPage } = fetcher({
      responses: [page('x'.repeat(5_000))],
      maxResponseBytes: 2_048,
    })

    await expect(fetchPage('https://example.com/big'))
      .rejects.toMatchObject({ code: 'EGRESS_RESPONSE_TOO_LARGE' })
  })

  it('stops waiting for a server that never answers', async () => {
    vi.useFakeTimers()
    try {
      const fetchPage = makeOpenPageFetch({
        timeoutMs: 1_000,
        resolve: async () => PUBLIC,
        transport: {
          get: async (request) => await new Promise<PinnedHttpsResponse>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          }),
        },
      })
      const pending = fetchPage('https://example.com/slow')
      const assertion = expect(pending).rejects.toMatchObject({ code: 'EGRESS_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(1_100)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('turning a page into text', () => {
  it('drops scripts, styles and markup but keeps the prose', () => {
    const text = extractReadableText(
      '<html><head><style>.a{color:red}</style><script>alert(1)</script></head>' +
      '<body><h1>Канал</h1><p>Про инструменты &amp; агентов</p><!-- заметка --></body></html>',
    )

    expect(text).toContain('Канал')
    expect(text).toContain('Про инструменты & агентов')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('заметка')
    expect(text).not.toContain('<')
  })

  it('keeps block boundaries as line breaks', () => {
    expect(extractReadableText('<p>первый</p><p>второй</p>').split('\n').filter(Boolean))
      .toEqual(['первый', 'второй'])
  })

  it('bounds one page so it cannot eat the context window', () => {
    const text = extractReadableText(`<p>${'а'.repeat(60_000)}</p>`)

    expect(text.length).toBeLessThan(41_000)
    expect(text).toContain('обрезана')
  })
})

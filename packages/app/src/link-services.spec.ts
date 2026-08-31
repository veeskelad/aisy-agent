import { describe, expect, it, vi } from 'vitest'

import {
  makeLinkReader,
  makeServiceSearch,
  renderSearchFailure,
  routeLink,
  SERVICE_HOSTS,
} from './link-services.js'
import type { PinnedJsonCall } from './pinned-https-egress.js'

/** What the free reader answers with, in the shape r.jina.ai actually returns. */
function readerAnswer(content: string): unknown {
  return { code: 200, status: 20000, data: { title: 'страница', url: 'https://x', content } }
}

function reader(options: {
  keys?: Record<string, string>
  answer?: unknown
  /** Answer for the free reader; absent ⇒ it returns nothing usable. */
  free?: unknown
  direct?: (url: string) => Promise<{ url: string; text: string }>
} = {}) {
  const calls: PinnedJsonCall[] = []
  const read = makeLinkReader({
    json: async (call) => {
      calls.push(call)
      if (call.url.startsWith('https://r.jina.ai/')) return options.free ?? {}
      return options.answer ?? {}
    },
    key: (envKey) => options.keys?.[envKey],
    direct: options.direct ?? (async (url) => ({
      url,
      text: `прямая страница ${url}, достаточно длинная, чтобы не считаться пустой: ` +
        'тут ещё немного текста ради порога, за которым страница признаётся оболочкой ' +
        'без содержимого и уводится в скрейпер.',
    })),
  })
  return { read, calls }
}

describe('which road a link takes', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', 'transcript'],
    ['https://youtu.be/abc', 'transcript'],
    ['https://vm.tiktok.com/ZM123/', 'transcript'],
    ['https://www.instagram.com/reel/abc/', 'transcript'],
    ['https://www.instagram.com/someone/', 'scrape'],
    ['https://x.com/someone/status/1', 'scrape'],
    ['https://vk.com/wall-1_2', 'scrape'],
    ['https://example.com/article', 'direct'],
    ['https://blog.example.com/2026/post', 'direct'],
    ['не ссылка вовсе', 'direct'],
  ])('%s → %s', (url, expected) => {
    expect(routeLink(url)).toBe(expected)
  })

  it('keeps every service host inside the egress allowlist shape', () => {
    // 1..32 lowercase hostnames is what makePinnedHttpsJson accepts; a typo
    // here would only surface as a runtime config failure on the server.
    expect(SERVICE_HOSTS.length).toBeGreaterThan(0)
    for (const host of SERVICE_HOSTS) expect(host).toBe(host.toLowerCase())
  })
})

describe('search failure wording', () => {
  it('uses a concrete Russian cause without inventing a disabled network mode', () => {
    expect(renderSearchFailure(new Error('EGRESS_TRANSPORT_FAILED')))
      .toBe('не удалось соединиться с поиском')
    expect(renderSearchFailure(new Error('unexpected'))).toBe('поиск временно недоступен')
    expect(renderSearchFailure(new Error('EGRESS_TRANSPORT_FAILED')))
      .not.toMatch(/EGRESS|режим|доступ в сеть закрыт/i)
  })
})

describe('reading a link', () => {
  it('does not mistake an attacker-owned lookalike for Instagram', () => {
    expect(routeLink('https://evilinstagram.com/reel/1')).toBe('direct')
  })

  it('sends an ordinary page down the direct road, untouched', async () => {
    const direct = vi.fn(async (url: string) => ({ url, text: 'т'.repeat(300) }))
    const h = reader({ direct })

    await expect(h.read('https://example.com/a')).resolves.toBe(
      `Источник: https://example.com/a\n\n${'т'.repeat(300)}`)
    expect(h.calls).toHaveLength(0)
    expect(direct).toHaveBeenCalledOnce()
  })

  it('asks Supadata for a video and carries the key in a header', async () => {
    const h = reader({
      keys: { AISY_SUPADATA_KEY: 'supadata-key' },
      answer: { content: 'привет, это расшифровка' },
    })

    const text = await h.read('https://youtu.be/abc')

    expect(text).toContain('привет, это расшифровка')
    const call = h.calls[0]!
    expect(call.headers).toEqual({ 'x-api-key': 'supadata-key' })
    // The link is a query parameter, the credential is not — that is the whole
    // rule about where a key may travel.
    expect(call.url).toContain('url=https%3A%2F%2Fyoutu.be%2Fabc')
    expect(call.url).not.toContain('supadata-key')
  })

  it('joins a segmented transcript instead of reporting nothing', async () => {
    const h = reader({
      keys: { AISY_SUPADATA_KEY: 'k' },
      answer: { content: [{ text: 'первый' }, { text: 'второй' }] },
    })

    await expect(h.read('https://youtu.be/abc')).resolves.toContain('первый второй')
  })

  it('says which screen fixes a missing key instead of just failing', async () => {
    const h = reader({ answer: {} })

    const video = await h.read('https://youtu.be/abc')
    expect(video).toContain('Supadata')
    expect(video).toContain('Настройки')
    expect(h.calls).toHaveLength(0)

    const feed = await h.read('https://www.instagram.com/someone/')
    expect(feed).toContain('Apify')
    expect(feed).toContain('Настройки')
    // The free reader was asked first and had nothing; only then is a key named.
    expect(h.calls).toHaveLength(1)
  })

  it('runs the Apify crawler for a page that hides behind a login', async () => {
    const h = reader({
      keys: { AISY_APIFY_TOKEN: 'apify-token' },
      answer: [{ text: 'содержимое профиля' }],
    })

    const text = await h.read('https://www.instagram.com/someone/')

    expect(text).toContain('содержимое профиля')
    // calls[0] is the free reader, which had nothing for a login-walled feed.
    const call = h.calls[1]!
    expect(call.method).toBe('POST')
    expect(call.headers).toEqual({ authorization: 'Bearer apify-token' })
    // Apify also accepts `?token=`, which would put the credential in their
    // access log. It goes in the header.
    expect(call.url).not.toContain('apify-token')
    expect(JSON.parse(call.body!)).toMatchObject({
      startUrls: [{ url: 'https://www.instagram.com/someone/' }],
      maxCrawlPages: 1,
    })
  })

  it('reports an empty scrape as a closed page, not as success', async () => {
    const h = reader({ keys: { AISY_APIFY_TOKEN: 't' }, answer: [] })

    await expect(h.read('https://x.com/a/status/1')).resolves.toContain('закрыта или требует входа')
  })

  it('renders a page that came back empty through the crawler', async () => {
    // 200 with nothing readable is a shell drawn by script. The crawler runs a
    // real browser on the service's side, so an operator with this key needs no
    // Chromium of their own.
    const h = reader({
      keys: { AISY_APIFY_TOKEN: 'apify-token' },
      answer: [{ markdown: 'настоящее содержимое страницы' }],
      direct: async (url) => ({ url, text: '   ' }),
    })

    const text = await h.read('https://spa.example.com/app')

    expect(text).toContain('настоящее содержимое страницы')
    // Free reader first, paid crawler second — that order is the point.
    expect(h.calls).toHaveLength(2)
    expect(h.calls[0]!.url.startsWith('https://r.jina.ai/')).toBe(true)
    expect(h.calls[1]!.url).toContain('api.apify.com')
  })

  it('offers the key instead of handing back an empty page', async () => {
    const h = reader({ direct: async (url) => ({ url, text: 'Загрузка…' }) })

    const text = await h.read('https://spa.example.com/app')

    expect(text).toContain('рисует скрипт')
    expect(text).toContain('Apify')
    // What little there was is still shown — it may be the error the site gave.
    expect(text).toContain('Загрузка…')
    // One call: the free reader was tried and answered with nothing.
    expect(h.calls).toHaveLength(1)
  })

  it('keeps the direct answer when the crawler has nothing to add', async () => {
    const h = reader({
      keys: { AISY_APIFY_TOKEN: 't' },
      answer: [],
      direct: async (url) => ({ url, text: 'короткая заметка' }),
    })

    await expect(h.read('https://example.com/note')).resolves.toContain('короткая заметка')
  })

  it('converts a document the process cannot read itself', async () => {
    // A PDF is refused by content type, not by address: the link was fine, the
    // body is simply not text. The free reader turns it into text.
    const h = reader({
      free: readerAnswer('т'.repeat(400)),
      direct: async () => { throw new Error('EGRESS_RESPONSE_DENIED') },
    })

    const text = await h.read('https://arxiv.org/pdf/1706.03762')

    expect(text).toContain('т'.repeat(400))
    expect(h.calls[0]!.url).toBe('https://r.jina.ai/https://arxiv.org/pdf/1706.03762')
    expect(h.calls[0]!.headers).toEqual({ accept: 'application/json' })
  })

  it('keeps a refusal about the address away from the reader', async () => {
    // A denied address, a private range, a DNS failure — these say *where* the
    // link points is not allowed. Handing them to a service that fetches on our
    // behalf would turn the free road into a way around the check.
    for (const code of ['EGRESS_URL_DENIED', 'EGRESS_ADDRESS_DENIED', 'EGRESS_DNS_FAILED']) {
      const h = reader({
        free: readerAnswer('т'.repeat(400)),
        direct: async () => { throw new Error(code) },
      })

      await expect(h.read('https://example.com/a')).rejects.toThrow(code)
      expect(h.calls).toHaveLength(0)
    }
  })

  it('keeps the original refusal when nothing can convert the link', async () => {
    const h = reader({ direct: async () => { throw new Error('EGRESS_RESPONSE_DENIED') } })

    await expect(h.read('https://example.com/a.docx')).rejects.toThrow('EGRESS_RESPONSE_DENIED')
  })

  it('renders an empty page for free, without spending a key', async () => {
    const h = reader({
      keys: { AISY_APIFY_TOKEN: 'apify-token' },
      free: readerAnswer('содержимое, нарисованное скриптом, и его достаточно много'.repeat(6)),
      direct: async (url) => ({ url, text: '   ' }),
    })

    const text = await h.read('https://spa.example.com/app')

    expect(text).toContain('нарисованное скриптом')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.url).toContain('r.jina.ai')
  })

  it('treats a login wall from the reader as a refusal, not as content', async () => {
    // A short answer is what a login page returns. Passing it on would look to
    // the model exactly like the page was read.
    const h = reader({
      keys: { AISY_APIFY_TOKEN: 'apify-token' },
      free: readerAnswer('Log in to continue'),
      answer: [{ text: 'содержимое профиля' }],
    })

    const text = await h.read('https://www.instagram.com/someone/')

    expect(text).toContain('содержимое профиля')
    expect(h.calls).toHaveLength(2)
  })

  it('does not send a link that carries no host to the reader', async () => {
    const h = reader({
      free: readerAnswer('т'.repeat(400)),
      direct: async () => { throw new Error('EGRESS_RESPONSE_DENIED') },
    })

    await expect(h.read('http://example.com/a')).rejects.toThrow('EGRESS_RESPONSE_DENIED')
    expect(h.calls).toHaveLength(0)
  })

  it('reports a video with no subtitles plainly', async () => {
    const h = reader({ keys: { AISY_SUPADATA_KEY: 'k' }, answer: { content: '' } })

    await expect(h.read('https://youtu.be/abc')).resolves.toContain('нет субтитров')
  })
})

describe('search through a service', () => {
  it('returns null without a key, so the caller keeps the free path', async () => {
    const search = makeServiceSearch({ json: async () => ({}), key: () => undefined })

    await expect(search('aisy')).resolves.toBeNull()
  })

  it('maps Serper results into the shape web_search already prints', async () => {
    const calls: PinnedJsonCall[] = []
    const search = makeServiceSearch({
      json: async (call) => {
        calls.push(call)
        return {
          organic: [
            { title: 'Aisy', link: 'https://example.com/a', snippet: 'харнесс' },
            { link: 'https://example.com/b' },
            { title: 'нет ссылки' },
          ],
        }
      },
      key: () => 'serper-key',
    })

    const results = await search('aisy harness')

    expect(results).toEqual([
      { title: 'Aisy', url: 'https://example.com/a', snippet: 'харнесс' },
      // A result without a title falls back to its own url; one without a url
      // is not a result at all.
      { title: 'https://example.com/b', url: 'https://example.com/b', snippet: '' },
    ])
    expect(calls[0]).toMatchObject({
      url: 'https://google.serper.dev/search',
      method: 'POST',
      headers: { 'x-api-key': 'serper-key' },
    })
    expect(JSON.parse(calls[0]!.body!)).toEqual({ q: 'aisy harness' })
  })

  it('survives an answer whose shape nobody promised', async () => {
    const search = makeServiceSearch({ json: async () => ({ unexpected: true }), key: () => 'k' })

    await expect(search('aisy')).resolves.toEqual([])
  })
})

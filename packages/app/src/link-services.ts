// Three keys the operator was already offered, finally doing something.
//
// The key catalogue promises Serper ("нормальный поиск"), Supadata ("транскрипты
// видео") and Apify ("скрейперы для площадок, которые не отдают данные"). Until
// now all three were stored and never read: `web_search` went to a DuckDuckGo
// HTML parser and `fetch_url` always tried to read raw HTML, which a video page
// or a social feed simply does not have.
//
// The model still knows one tool per job — `web_search` and `fetch_url`. Which
// service answers is an implementation detail decided here by the link's host:
// an agent that had to pick between Apify and a direct fetch would be choosing
// on behalf of a bill it cannot see.
//
// Free before paid, in that order. A reader that renders on its own side and
// converts documents to text costs nothing and needs no key, so it runs first
// and a paid crawler is spent only on what it refuses. That order is also what
// keeps a browser off this machine: rendering happens elsewhere, and 2 GB of
// server memory never hosts a Chromium that the OOM killer would trade for the
// agent itself.

import type { PinnedJsonCall } from './pinned-https-egress.js'

/** Where a link's content actually lives. */
export type LinkRoute = 'direct' | 'transcript' | 'scrape'

const VIDEO_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
  'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com',
  'rutube.ru', 'www.rutube.ru',
])
/** Hosts that answer a plain GET with a login wall or an empty shell. */
const SCRAPE_HOSTS = new Set([
  'instagram.com', 'www.instagram.com',
  'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com',
  'facebook.com', 'www.facebook.com',
  'linkedin.com', 'www.linkedin.com',
  'threads.net', 'www.threads.net',
  'vk.com', 'www.vk.com',
])
const INSTAGRAM_VIDEO = /^\/(?:reel|reels|p|tv)\//

/**
 * Which road a link takes. Instagram is the one host that splits: a reel is a
 * video with a transcript, a profile is a page to scrape.
 */
export function routeLink(rawUrl: string): LinkRoute {
  let url: URL
  try { url = new URL(rawUrl) } catch { return 'direct' }
  const host = url.hostname.toLowerCase()
  if (VIDEO_HOSTS.has(host)) return 'transcript'
  if (host === 'instagram.com' || host === 'www.instagram.com') {
    return INSTAGRAM_VIDEO.test(url.pathname) ? 'transcript' : 'scrape'
  }
  return SCRAPE_HOSTS.has(host) ? 'scrape' : 'direct'
}

/** Hosts the JSON egress may dial. Nothing else is reachable from here. */
export const SERVICE_HOSTS: readonly string[] = Object.freeze([
  'google.serper.dev', 'api.supadata.ai', 'api.apify.com', 'r.jina.ai',
])

const SEARCH_FAILURE: Readonly<Record<string, string>> = Object.freeze({
  EGRESS_QUERY_DENIED: 'поисковый запрос содержит данные, которые нельзя отправлять наружу',
  EGRESS_DNS_FAILED: 'не удалось найти поисковый сервер',
  EGRESS_ADDRESS_DENIED: 'поисковый сервер вернул недопустимый адрес',
  EGRESS_TIMEOUT: 'поиск не ответил вовремя',
  EGRESS_TRANSPORT_FAILED: 'не удалось соединиться с поиском',
  EGRESS_REMOTE_ADDRESS_MISMATCH: 'адрес поискового сервера изменился во время соединения',
  EGRESS_RESPONSE_DENIED: 'поисковый сервис вернул неподходящий ответ',
  EGRESS_RESPONSE_TOO_LARGE: 'ответ поиска оказался слишком большим',
  EGRESS_RESPONSE_INVALID: 'ответ поиска не удалось прочитать',
})

/** Stable Russian result for a failed search; never guesses about runtime mode. */
export function renderSearchFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  return SEARCH_FAILURE[code] ?? 'поиск временно недоступен'
}

/** The free reader. Renders a page on its side and converts PDFs to text. */
const READER_HOST = 'https://r.jina.ai/'

/**
 * Refusals that mean "the address was fine, the answer was not readable here" —
 * a PDF, an office document, a body too large to snapshot. Everything else
 * (a denied URL, a private address, a DNS failure) is a refusal about *where*
 * the link points and must never be handed to a service to try again.
 */
const CONTENT_REFUSAL = new Set([
  'EGRESS_RESPONSE_DENIED', 'EGRESS_RESPONSE_INVALID', 'EGRESS_RESPONSE_TOO_LARGE',
])

function contentRefusal(error: unknown): boolean {
  return error instanceof Error && CONTENT_REFUSAL.has(error.message)
}

/**
 * The reader takes its target in the path, so the link is rebuilt rather than
 * pasted: https only, no credentials, no port, no fragment — the same shape the
 * egress would demand of the link itself.
 */
function readerUrl(rawUrl: string): string | null {
  let url: URL
  try { url = new URL(rawUrl) } catch { return null }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.port !== '' || url.hostname.length === 0) return null
  url.hash = ''
  return `${READER_HOST}${url.toString()}`
}

function readerText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const data = (payload as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null
  const content = (data as { content?: unknown }).content
  return typeof content === 'string' && content.trim().length > 0 ? content : null
}

export interface LinkServiceDeps {
  /** JSON call through the pinned egress (method, headers, body). */
  json: (call: PinnedJsonCall) => Promise<unknown>
  /** Reads a service credential from the vault; absent ⇒ the service is off. */
  key: (envKey: string) => string | undefined
}

/**
 * What to say when the road exists but the key does not. Naming the exact
 * screen is the difference between a dead end and a two-tap fix — the operator
 * was offered this key on that very screen.
 */
function missingKey(service: string, why: string): string {
  return `${why} Подключается за минуту: ⚙️ Настройки → 🔑 Ключи сервисов → ${service}.`
}

const MAX_SERVICE_TEXT = 40_000

function clamp(text: string): string {
  return text.length <= MAX_SERVICE_TEXT ? text : `${text.slice(0, MAX_SERVICE_TEXT)}\n…`
}

/** Pull the readable text out of an answer whose exact shape varies by plan. */
function transcriptText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const content = (payload as { content?: unknown }).content
  if (typeof content === 'string' && content.trim().length > 0) return content
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => typeof item === 'object' && item !== null
        ? (item as { text?: unknown }).text
        : null)
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
    if (parts.length > 0) return parts.join(' ')
  }
  return null
}

function scrapedText(payload: unknown): string | null {
  const items = Array.isArray(payload) ? payload : null
  if (items === null || items.length === 0) return null
  const first = items[0]
  if (typeof first !== 'object' || first === null) return null
  for (const field of ['text', 'markdown', 'content'] as const) {
    const value = (first as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

export interface LinkReaderDeps extends LinkServiceDeps {
  /** The pinned open fetcher — the road for anything without a service. */
  direct: (url: string) => Promise<{ url: string; text: string }>
}

/**
 * Below this, a page that answered 200 carries no article: it is a shell whose
 * content arrives by script. Chosen to clear a cookie banner and a nav bar
 * without swallowing a genuinely short post.
 */
const EMPTY_PAGE_CHARS = 200

/**
 * One entry point for "give me what is behind this link". Returns text ready to
 * hand the model; every failure is a sentence the operator can act on, because
 * the model will read it out loud.
 */
export function makeLinkReader(deps: LinkReaderDeps): (url: string) => Promise<string> {
  const scrape = async (url: string, key: string): Promise<string | null> => {
    const payload = await deps.json({
      url: 'https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items',
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      // One page, rendered: this is the actor that runs a real browser on their
      // side, which is also why it is the road for a page a plain GET returns
      // empty.
      body: JSON.stringify({
        startUrls: [{ url }],
        maxCrawlPages: 1,
        maxCrawlDepth: 0,
        crawlerType: 'playwright:adaptive',
        saveMarkdown: true,
      }),
    })
    const text = scrapedText(payload)
    return text === null ? null : `Источник: ${url}\n\n${clamp(text)}`
  }

  /**
   * The free road: a reader that renders the page on its side and turns a PDF
   * into text. It runs before anything the operator pays for — and before any
   * browser of ours would — so the paid key is only spent on what it refuses.
   * A thin answer counts as a refusal: a login wall is text, and returning it
   * would look to the model like the page was read.
   */
  const reader = async (url: string): Promise<string | null> => {
    const target = readerUrl(url)
    if (target === null) return null
    let payload: unknown
    try {
      payload = await deps.json({ url: target, headers: { accept: 'application/json' } })
    } catch {
      return null
    }
    const text = readerText(payload)
    if (text === null || text.trim().length < EMPTY_PAGE_CHARS) return null
    return `Источник: ${url}\n\n${clamp(text)}`
  }

  return async (url: string): Promise<string> => {
    const route = routeLink(url)
    if (route === 'direct') {
      let page: { url: string; text: string }
      try {
        page = await deps.direct(url)
      } catch (error) {
        // A PDF or an office document: the address was fine, the body is simply
        // not text this process knows how to read. The reader converts it, and
        // a link nobody can convert keeps its original honest refusal.
        if (!contentRefusal(error)) throw error
        const converted = await reader(url)
        if (converted === null) throw error
        return converted
      }
      // A 200 with nothing readable is a page drawn by script. The reader
      // renders it for free; the crawler is the fallback for what it refuses.
      if (page.text.trim().length < EMPTY_PAGE_CHARS) {
        const rendered = await reader(url)
        if (rendered !== null) return rendered
        const key = deps.key('AISY_APIFY_TOKEN')
        const scraped = key === undefined ? null : await scrape(url, key)
        if (scraped !== null) return scraped
        if (key === undefined) {
          return `${missingKey('🕷 Apify',
            'Страница открылась пустой — её рисует скрипт, и бесплатный ридер её не взял.')}` +
            `\n\nЧто удалось прочитать: ${page.text.trim()}`
        }
      }
      return `Источник: ${page.url}\n\n${page.text}`
    }

    if (route === 'transcript') {
      const key = deps.key('AISY_SUPADATA_KEY')
      if (key === undefined) {
        return missingKey('📹 Supadata',
          'Это видео — расшифровку я беру через Supadata, а ключа к нему нет.')
      }
      const payload = await deps.json({
        url: `https://api.supadata.ai/v1/transcript?text=true&url=${encodeURIComponent(url)}`,
        headers: { 'x-api-key': key },
      })
      const text = transcriptText(payload)
      return text === null
        ? 'Сервис не дал расшифровку этого видео — возможно, у него нет субтитров.'
        : `Расшифровка видео: ${url}\n\n${clamp(text)}`
    }

    const rendered = await reader(url)
    if (rendered !== null) return rendered
    const key = deps.key('AISY_APIFY_TOKEN')
    if (key === undefined) {
      return missingKey('🕷 Apify',
        'Эта площадка не отдаёт страницу напрямую и бесплатному ридеру тоже не открылась.')
    }
    return (await scrape(url, key))
      ?? 'Скрейпер вернул пустой ответ — страница закрыта или требует входа.'
  }
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Serper search, or null when there is no key — the caller then keeps the free
 * DuckDuckGo path. The result shape is the one `web_search` already prints, so
 * the tool's contract with the model does not change: only the quality does.
 */
export function makeServiceSearch(
  deps: LinkServiceDeps,
): (query: string) => Promise<readonly SearchResult[] | null> {
  return async (query: string) => {
    const key = deps.key('AISY_SERPER_KEY')
    if (key === undefined) return null
    const payload = await deps.json({
      url: 'https://google.serper.dev/search',
      method: 'POST',
      headers: { 'x-api-key': key },
      body: JSON.stringify({ q: query }),
    })
    const organic = typeof payload === 'object' && payload !== null
      ? (payload as { organic?: unknown }).organic
      : null
    if (!Array.isArray(organic)) return []
    const results: SearchResult[] = []
    for (const entry of organic.slice(0, 8)) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const url = typeof record['link'] === 'string' ? record['link'] : null
      if (url === null) continue
      results.push({
        title: typeof record['title'] === 'string' ? record['title'] : url,
        url,
        snippet: typeof record['snippet'] === 'string' ? record['snippet'] : '',
      })
    }
    return results
  }
}

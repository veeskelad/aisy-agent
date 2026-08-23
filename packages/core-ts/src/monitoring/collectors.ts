import { createHash } from 'node:crypto'
import { htmlToText, isPublicHttpUrl } from '../runtime/web-tools.js'
import { MonitoringError } from './errors.js'
import type {
  CollectedEvidence,
  CollectionBatch,
  MonitoringCollector,
  MonitoringHttpPort,
  MonitoringHttpResponse,
  MonitoringSource,
  MonitoringSourceKind,
} from './types.js'

const MAX_BODY_BYTES = 2_000_000

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_all, raw: string) => String.fromCodePoint(Number(raw)))
    .trim()
}

function tag(block: string, names: string[]): string | undefined {
  for (const name of names) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block)
    if (match?.[1]) return decodeXml(match[1])
  }
  return undefined
}

function attr(block: string, tagName: string, attrName: string): string | undefined {
  const element = new RegExp(`<${tagName}\\b([^>]*)>`, 'i').exec(block)?.[1]
  if (!element) return undefined
  return decodeXml(new RegExp(`\\b${attrName}=["']([^"']+)["']`, 'i').exec(element)?.[1] ?? '') || undefined
}

function text(value: string | undefined, max = 100_000): string {
  if (!value) return ''
  return htmlToText(value, max).trim()
}

function feedBlocks(xml: string): string[] {
  const out: string[] = []
  for (const pattern of [/<item\b[\s\S]*?<\/item>/gi, /<entry\b[\s\S]*?<\/entry>/gi]) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(xml)) !== null) out.push(match[0])
  }
  return out
}

export function parseMonitoringFeed(xml: string): CollectedEvidence[] {
  return feedBlocks(xml).flatMap((block) => {
    const primaryUrl = tag(block, ['link']) || attr(block, 'link', 'href') || ''
    const externalId = tag(block, ['guid', 'id']) || primaryUrl
    const title = text(tag(block, ['title']), 1000)
    const content = text(tag(block, ['content:encoded', 'content', 'description', 'summary']))
    const author = text(tag(block, ['author', 'dc:creator']), 500)
    const publishedAt = tag(block, ['pubDate', 'published', 'updated'])
    if (!externalId || !primaryUrl || !title || !content || !isPublicHttpUrl(primaryUrl)) return []
    return [{
      externalId,
      primaryUrl,
      title,
      text: content,
      ...(author.length === 0 ? {} : { author }),
      ...(publishedAt === undefined || !Number.isFinite(Date.parse(publishedAt))
        ? {} : { publishedAt: new Date(publishedAt).toISOString() }),
    }]
  })
}

function cursorFor(response: MonitoringHttpResponse): string {
  return response.etag ?? response.lastModified ??
    `sha256:${createHash('sha256').update(response.body).digest('hex')}`
}

async function fetchChanged(
  source: MonitoringSource,
  port: MonitoringHttpPort,
  url: string,
): Promise<{ response?: MonitoringHttpResponse; cursor: string }> {
  if (!isPublicHttpUrl(url)) throw new MonitoringError('INVALID_SOURCE')
  const response = await port.get({
    sourceId: source.id,
    url,
    maxBytes: MAX_BODY_BYTES,
    ...(source.cursor?.startsWith('"') === true ? { etag: source.cursor } : {}),
    ...(source.cursor !== undefined && !source.cursor.startsWith('"') && !source.cursor.startsWith('sha256:')
      ? { lastModified: source.cursor } : {}),
  })
  if (response.status === 304) return { cursor: source.cursor ?? 'not-modified' }
  if (response.status < 200 || response.status >= 300 ||
    Buffer.byteLength(response.body) > MAX_BODY_BYTES || !isPublicHttpUrl(response.finalUrl)) {
    throw new MonitoringError('INVALID_EVIDENCE')
  }
  const cursor = cursorFor(response)
  if (source.cursor === cursor) return { cursor }
  return { response, cursor }
}

function assertKind(source: MonitoringSource, kind: MonitoringSourceKind): void {
  if (source.kind !== kind) throw new MonitoringError('INVALID_SOURCE')
}

function feedCollector(kind: 'rss' | 'youtube' | 'github', port: MonitoringHttpPort,
  resolveUrl: (source: MonitoringSource) => string): MonitoringCollector {
  return {
    async collect(source): Promise<CollectionBatch> {
      assertKind(source, kind)
      const fetched = await fetchChanged(source, port, resolveUrl(source))
      return {
        items: fetched.response === undefined ? [] : parseMonitoringFeed(fetched.response.body),
        cursor: fetched.cursor,
      }
    },
  }
}

export function makeRssMonitoringCollector(port: MonitoringHttpPort): MonitoringCollector {
  return feedCollector('rss', port, (source) => source.locator)
}

export function makeYouTubeMonitoringCollector(port: MonitoringHttpPort): MonitoringCollector {
  return feedCollector('youtube', port, (source) => {
    if (isPublicHttpUrl(source.locator)) return source.locator
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(source.locator)) throw new MonitoringError('INVALID_SOURCE')
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(source.locator)}`
  })
}

export function makeGitHubMonitoringCollector(port: MonitoringHttpPort): MonitoringCollector {
  return feedCollector('github', port, (source) => {
    if (!isPublicHttpUrl(source.locator)) throw new MonitoringError('INVALID_SOURCE')
    const url = new URL(source.locator)
    if (url.hostname.toLowerCase() !== 'github.com') throw new MonitoringError('INVALID_SOURCE')
    if (url.pathname.endsWith('.atom')) return url.toString()
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length !== 2) throw new MonitoringError('INVALID_SOURCE')
    return `https://github.com/${parts[0]}/${parts[1]}/releases.atom`
  })
}

function titleOfHtml(html: string, fallback: string): string {
  const raw = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  return text(raw, 1000) || fallback
}

export function makeWebMonitoringCollector(port: MonitoringHttpPort): MonitoringCollector {
  return {
    async collect(source) {
      assertKind(source, 'web')
      const fetched = await fetchChanged(source, port, source.locator)
      if (!fetched.response) return { items: [], cursor: fetched.cursor }
      const pageText = htmlToText(fetched.response.body, 500_000)
      if (pageText.length === 0) return { items: [], cursor: fetched.cursor }
      return {
        items: [{
          externalId: fetched.response.finalUrl,
          primaryUrl: fetched.response.finalUrl,
          title: titleOfHtml(fetched.response.body, fetched.response.finalUrl),
          text: pageText,
        }],
        cursor: fetched.cursor,
      }
    },
  }
}

export function parsePublicTelegramPage(html: string): CollectedEvidence[] {
  const starts = [...html.matchAll(/<div\b[^>]*class="[^"]*tgme_widget_message\b[^"]*"[^>]*data-post="[^"]+"[^>]*>/gi)]
  const blocks = starts.map((match, index) =>
    html.slice(match.index, starts[index + 1]?.index ?? html.length))
  return blocks.flatMap((block) => {
    const externalId = /\bdata-post="([^"]+)"/i.exec(block)?.[1] ?? ''
    const primaryUrl = /<a\b[^>]*class="[^"]*tgme_widget_message_date[^"]*"[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? ''
    const messageHtml = /<div\b[^>]*class="[^"]*tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1]
    const author = text(/<div\b[^>]*class="[^"]*tgme_widget_message_author[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1], 500)
    const published = /<time\b[^>]*datetime="([^"]+)"/i.exec(block)?.[1]
    const body = text(messageHtml)
    if (!externalId || !isPublicHttpUrl(primaryUrl) || !body) return []
    return [{
      externalId,
      primaryUrl,
      title: body.slice(0, 160),
      text: body,
      ...(author.length === 0 ? {} : { author }),
      ...(published === undefined || !Number.isFinite(Date.parse(published))
        ? {} : { publishedAt: new Date(published).toISOString() }),
    }]
  })
}

export function makeTelegramMonitoringCollector(port: MonitoringHttpPort): MonitoringCollector {
  return {
    async collect(source) {
      assertKind(source, 'telegram')
      const channel = source.locator.replace(/^@/, '')
      if (!/^[A-Za-z0-9_]{5,64}$/.test(channel)) throw new MonitoringError('INVALID_SOURCE')
      const fetched = await fetchChanged(source, port, `https://t.me/s/${channel}`)
      return {
        items: fetched.response === undefined ? [] : parsePublicTelegramPage(fetched.response.body),
        cursor: fetched.cursor,
      }
    },
  }
}

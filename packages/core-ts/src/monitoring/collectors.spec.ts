import { describe, expect, it, vi } from 'vitest'
import {
  makeGitHubMonitoringCollector,
  makeRssMonitoringCollector,
  makeTelegramMonitoringCollector,
  makeWebMonitoringCollector,
  makeYouTubeMonitoringCollector,
  parseMonitoringFeed,
  parsePublicTelegramPage,
} from './collectors.js'
import type {
  MonitoringHttpPort,
  MonitoringHttpResponse,
  MonitoringSource,
  MonitoringSourceKind,
} from './types.js'

const BINDING = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'monitor-a',
  scope: 'project' as const,
}

function source(kind: MonitoringSourceKind, locator: string, cursor?: string): MonitoringSource {
  return {
    schemaVersion: 1,
    id: `source-${kind}`,
    kind,
    locator,
    binding: BINDING,
    criteria: '',
    pollIntervalMs: 60_000,
    status: 'active',
    ...(cursor === undefined ? {} : { cursor }),
    createdAt: '2026-07-27T09:00:00.000Z',
    updatedAt: '2026-07-27T09:00:00.000Z',
  }
}

function http(response: MonitoringHttpResponse) {
  const get = vi.fn<MonitoringHttpPort['get']>(async () => response)
  return { port: { get } satisfies MonitoringHttpPort, get }
}

const RSS = `<?xml version="1.0"?><rss><channel><item>
  <guid>post-1</guid><link>https://example.com/post-1</link>
  <title>Aisy &amp; agents</title>
  <description><![CDATA[<p>Production release details.</p>]]></description>
  <dc:creator>Alice</dc:creator><pubDate>Mon, 27 Jul 2026 08:00:00 GMT</pubDate>
</item></channel></rss>`

const ATOM = `<feed><entry><id>tag:github.com,release-1</id>
  <link href="https://github.com/veeskelad/aisy/releases/tag/v1" />
  <title>v1 release</title><content type="html">&lt;p&gt;Release notes&lt;/p&gt;</content>
  <author>Maintainer</author><updated>2026-07-27T08:00:00Z</updated>
</entry></feed>`

describe('deterministic monitoring collectors', () => {
  it('parses RSS/Atom evidence with primary links and normalized timestamps', () => {
    expect(parseMonitoringFeed(RSS)).toEqual([expect.objectContaining({
      externalId: 'post-1',
      primaryUrl: 'https://example.com/post-1',
      title: 'Aisy & agents',
      text: 'Production release details.',
      author: 'Alice',
      publishedAt: '2026-07-27T08:00:00.000Z',
    })])
    expect(parseMonitoringFeed(ATOM)).toEqual([expect.objectContaining({
      externalId: 'tag:github.com,release-1',
      primaryUrl: 'https://github.com/veeskelad/aisy/releases/tag/v1',
      title: 'v1 release',
    })])
  })

  it('uses ETag/change cursor and returns no items for the same response', async () => {
    const transport = http({
      status: 200,
      body: RSS,
      finalUrl: 'https://example.com/feed.xml',
      etag: '"feed-v1"',
    })
    const collector = makeRssMonitoringCollector(transport.port)
    await expect(collector.collect(source('rss', 'https://example.com/feed.xml', '"feed-v1"')))
      .resolves.toEqual({ items: [], cursor: '"feed-v1"' })
    expect(transport.get).toHaveBeenCalledWith(expect.objectContaining({ etag: '"feed-v1"' }))
  })

  it('maps a GitHub repository to its release Atom feed', async () => {
    const transport = http({ status: 200, body: ATOM, finalUrl: 'https://github.com/veeskelad/aisy/releases.atom' })
    const result = await makeGitHubMonitoringCollector(transport.port)
      .collect(source('github', 'https://github.com/veeskelad/aisy'))

    expect(transport.get).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'source-github',
      url: 'https://github.com/veeskelad/aisy/releases.atom',
      maxBytes: 2_000_000,
    }))
    expect(result.items).toHaveLength(1)
  })

  it('maps a YouTube channel id to the public videos feed', async () => {
    const transport = http({ status: 200, body: ATOM, finalUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890' })
    await makeYouTubeMonitoringCollector(transport.port)
      .collect(source('youtube', 'UC1234567890'))
    expect(transport.get).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890',
    }))
  })

  it('extracts a bounded readable web-page evidence item', async () => {
    const transport = http({
      status: 200,
      body: '<html><head><title>Aisy status</title><script>secret()</script></head><body><h1>All systems operational</h1></body></html>',
      finalUrl: 'https://status.example.com/',
    })
    const result = await makeWebMonitoringCollector(transport.port)
      .collect(source('web', 'https://status.example.com/'))
    expect(result.items).toEqual([expect.objectContaining({
      externalId: 'https://status.example.com/',
      primaryUrl: 'https://status.example.com/',
      title: 'Aisy status',
      text: 'All systems operational',
    })])
  })

  it('extracts public Telegram messages and uses the canonical post as evidence', async () => {
    const page = `<div class="tgme_widget_message" data-post="aisy_news/42">
      <div class="tgme_widget_message_author">Aisy News</div>
      <div class="tgme_widget_message_text"><b>Release</b> is ready.</div>
      <a class="tgme_widget_message_date" href="https://t.me/aisy_news/42"><time datetime="2026-07-27T08:00:00Z"></time></a>
    </div>`
    expect(parsePublicTelegramPage(page)).toEqual([expect.objectContaining({
      externalId: 'aisy_news/42',
      primaryUrl: 'https://t.me/aisy_news/42',
      title: 'Release is ready.',
      author: 'Aisy News',
      publishedAt: '2026-07-27T08:00:00.000Z',
    })])
    const transport = http({ status: 200, body: page, finalUrl: 'https://t.me/s/aisy_news' })
    await makeTelegramMonitoringCollector(transport.port)
      .collect(source('telegram', '@aisy_news'))
    expect(transport.get).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'source-telegram',
      url: 'https://t.me/s/aisy_news',
    }))
  })

  it('rejects private/local URLs before the HTTP port is called', async () => {
    const transport = http({ status: 200, body: RSS, finalUrl: 'http://127.0.0.1/feed' })
    await expect(makeRssMonitoringCollector(transport.port)
      .collect(source('rss', 'http://127.0.0.1/feed'))).rejects.toThrow('INVALID_SOURCE')
    expect(transport.get).not.toHaveBeenCalled()
  })
})

import type { MonitoringDigest } from '@aisy/core'
import { describe, expect, it } from 'vitest'
import {
  MonitoringDigestViewError,
  renderMonitoringDigest,
} from './monitoring-digest-view.js'

function digest(items: MonitoringDigest['items']): MonitoringDigest {
  return {
    schemaVersion: 1,
    id: 'digest-1',
    binding: {
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      sessionId: 'monitor-a', scope: 'project',
    },
    windowStart: '2026-07-27T00:00:00.000Z',
    windowEnd: '2026-07-27T09:00:00.000Z',
    notBefore: '2026-07-27T09:00:00.000Z',
    expiresAt: '2026-07-27T12:00:00.000Z',
    createdAt: '2026-07-27T09:00:00.000Z',
    status: 'ready',
    items,
  }
}

function item(index: number, overrides = {}): MonitoringDigest['items'][number] {
  return {
    evidenceId: `evidence-${index}`,
    sourceId: 'source-a',
    primaryUrl: `https://example.com/item/${index}?a=1&b=2`,
    title: `Материал ${index}`,
    summary: `Краткое описание ${index}`,
    whyUseful: `Практическая польза ${index}`,
    category: 'important',
    rawScore: 0.9,
    rankScore: 0.8,
    ...overrides,
  }
}

describe('monitoring digest Telegram view', () => {
  it('renders Russian evidence-linked HTML and escapes untrusted fields and URL attributes', () => {
    const view = renderMonitoringDigest(digest([
      item(1, { title: '<script> & отчёт', summary: '<b>не HTML</b>' }),
    ]))

    expect(view.html).toContain('📡 Дайджест Aisy')
    expect(view.html).toContain('&lt;script&gt; &amp; отчёт')
    expect(view.html).toContain('&lt;b&gt;не HTML&lt;/b&gt;')
    expect(view.html).toContain('href="https://example.com/item/1?a=1&amp;b=2"')
    expect(view.html).not.toContain('<script>')
    expect(view.renderedItems).toBe(1)
    expect(view.omittedItems).toBe(0)
  })

  it('keeps visible text within Telegram limit and reports omitted evidence', () => {
    const view = renderMonitoringDigest(digest(Array.from({ length: 20 }, (_, index) =>
      item(index, { summary: 'Описание '.repeat(100), whyUseful: 'Польза '.repeat(100) }),
    )))

    expect(view.visibleLength).toBe(view.text.length)
    expect(view.visibleLength).toBeLessThanOrEqual(4096)
    expect(view.renderedItems).toBeGreaterThan(0)
    expect(view.omittedItems).toBeGreaterThan(0)
    expect(view.html.match(/>Источник<\/a>/g)).toHaveLength(view.renderedItems)
    expect(view.text).toContain(`Ещё ${view.omittedItems}`)
  })

  it('renders an empty digest without inventing evidence', () => {
    const view = renderMonitoringDigest(digest([]))
    expect(view.text).toContain('Новых материалов')
    expect(view.renderedItems).toBe(0)
    expect(view.html).not.toContain('href=')
  })

  it('rejects malformed or userinfo-bearing evidence URLs', () => {
    const withUserinfo = new URL('https://example.com/item')
    withUserinfo.username = 'test-user'
    for (const primaryUrl of ['javascript:alert(1)', withUserinfo.toString()]) {
      expect(() => renderMonitoringDigest(digest([item(1, { primaryUrl })])))
        .toThrowError(expect.objectContaining<Partial<MonitoringDigestViewError>>({
          code: 'INVALID_EVIDENCE_URL',
        }))
    }
  })
})

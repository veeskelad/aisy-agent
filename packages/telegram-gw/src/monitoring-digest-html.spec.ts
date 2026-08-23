import { describe, expect, it } from 'vitest'

import { MAX_STYLE_CHARS, checkStyle, renderDigestHtml } from './monitoring-digest-html.js'

const item = (over: Partial<Parameters<typeof renderDigestHtml>[0]['items'][number]> = {}) => ({
  title: 'Выпуск 2.0',
  summary: 'Кратко о выпуске.',
  whyUseful: 'Затрагивает наш рантайм.',
  primaryUrl: 'https://example.com/release',
  category: 'important',
  ...over,
})

describe('HTML digest', () => {
  it('carries no script and forbids fetching anything', () => {
    const { html } = renderDigestHtml({ title: 'Дайджест', period: 'за неделю', items: [item()] })

    expect(html).not.toMatch(/<script/i)
    expect(html).toContain("default-src 'none'")
  })

  it('escapes material that tries to be markup', () => {
    const { html } = renderDigestHtml({
      title: 'Дайджест',
      period: 'за неделю',
      items: [item({
        title: '<img src=x onerror=alert(1)>',
        summary: '</style><script>alert(2)</script>',
      })],
    })

    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img')
  })

  it('keeps the text but drops the link for a non-http scheme', () => {
    const { html } = renderDigestHtml({
      title: 'Дайджест',
      period: 'за неделю',
      items: [item({ primaryUrl: 'javascript:alert(1)', title: 'Ссылка' })],
    })

    expect(html).not.toContain('javascript:')
    expect(html).toContain('Ссылка')
    expect(html).not.toMatch(/<a href="javascript/)
  })

  it('shows an explicit empty state', () => {
    const { html } = renderDigestHtml({ title: 'Дайджест', period: 'за день', items: [] })
    expect(html).toContain('ничего не набралось')
  })

  it('accepts plain operator styling', () => {
    const result = renderDigestHtml({
      title: 'Дайджест',
      period: 'за день',
      items: [item()],
      style: 'body { background: #101014; color: #e8e8ea }',
    })

    expect(result.styleRefusal).toBeUndefined()
    expect(result.html).toContain('#101014')
  })

  it('drops a stylesheet that can fetch or execute, rather than stripping parts of it', () => {
    for (const [css, refusal] of [
      ['@import url("https://evil.example/x.css");', 'import-not-allowed'],
      ['body { background: url(https://evil.example/pixel.png) }', 'url-not-allowed'],
      ['body { width: expression(alert(1)) }', 'expression-not-allowed'],
      ['body {} </style><script>alert(1)</script>', 'markup-not-allowed'],
      [`body { color: red } ${'/* padding */'.repeat(MAX_STYLE_CHARS)}`, 'too-long'],
    ] as const) {
      const result = renderDigestHtml({ title: 'Д', period: 'п', items: [item()], style: css })

      expect(result.styleRefusal).toBe(refusal)
      // Nothing of the refused stylesheet reaches the page.
      expect(result.html).not.toContain('evil.example')
      expect(result.html).not.toContain('expression(')
    }
  })

  it('reports the same verdict through checkStyle', () => {
    expect(checkStyle('body { color: red }')).toBe(true)
    expect(checkStyle('@IMPORT "x.css"')).toBe('import-not-allowed')
  })
})

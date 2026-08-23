// Self-contained HTML digest (ADR-0084 §UI).
//
// The digest is built entirely from untrusted material, so the page carries no
// script at all — not a hardened one, none. Operator styling is allowed, but
// only after a filter: CSS is the other way a page fetches and executes things.

import { escapeHtml } from './render.js'

export interface DigestHtmlItem {
  title: string
  summary: string
  whyUseful: string
  primaryUrl: string
  category: string
  author?: string
  publishedAt?: string
}

export type StyleRefusal =
  | 'import-not-allowed'
  | 'url-not-allowed'
  | 'expression-not-allowed'
  | 'markup-not-allowed'
  | 'too-long'

/** Upper bound of operator CSS; a stylesheet past this is a payload. */
export const MAX_STYLE_CHARS = 8_000

const FORBIDDEN: ReadonlyArray<[RegExp, StyleRefusal]> = [
  [/@import/i, 'import-not-allowed'],
  // `url(` covers remote fetches and `javascript:` alike, so it is one rule.
  [/url\s*\(/i, 'url-not-allowed'],
  [/expression\s*\(/i, 'expression-not-allowed'],
  [/<|>/, 'markup-not-allowed'],
]

/**
 * Check operator CSS before it reaches the page.
 *
 * A refusal is not a sanitisation: nothing is stripped and silently kept. Either
 * the stylesheet is plain styling, or it does not go in.
 */
export function checkStyle(css: string): true | StyleRefusal {
  if (css.length > MAX_STYLE_CHARS) return 'too-long'
  for (const [pattern, refusal] of FORBIDDEN) {
    if (pattern.test(css)) return refusal
  }
  return true
}

const BASE_STYLE = `
  :root { color-scheme: light dark }
  body { font: 16px/1.55 system-ui, sans-serif; margin: 0 auto; max-width: 46rem; padding: 2rem 1rem }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem }
  .period { color: #6b7280; margin: 0 0 2rem }
  article { border-top: 1px solid #e5e7eb; padding: 1.25rem 0 }
  h2 { font-size: 1.05rem; margin: 0 0 .35rem }
  .meta { color: #6b7280; font-size: .875rem; margin: 0 0 .5rem }
  .why { color: #374151; font-style: italic }
  a { color: inherit }
  .empty { color: #6b7280 }
`.trim()

/** Only http(s) links survive; anything else keeps its text and loses the link. */
function safeLink(url: string, text: string): string {
  const allowed = /^https?:\/\//i.test(url)
  return allowed
    ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow">${escapeHtml(text)}</a>`
    : escapeHtml(text)
}

export function renderDigestHtml(input: {
  title: string
  period: string
  items: readonly DigestHtmlItem[]
  /** Operator CSS; dropped entirely when it fails the filter. */
  style?: string
}): { html: string; styleRefusal?: StyleRefusal } {
  let styleRefusal: StyleRefusal | undefined
  let operatorStyle = ''
  if (input.style !== undefined && input.style.trim() !== '') {
    const verdict = checkStyle(input.style)
    if (verdict === true) operatorStyle = `\n${input.style}`
    else styleRefusal = verdict
  }

  const articles = input.items.length === 0
    ? ['<p class="empty">За этот период ничего не набралось.</p>']
    : input.items.map((item) => {
      const meta = [item.category, item.author, item.publishedAt]
        .filter((part): part is string => typeof part === 'string' && part !== '')
        .map(escapeHtml)
        .join(' · ')
      return [
        '<article>',
        `<h2>${safeLink(item.primaryUrl, item.title)}</h2>`,
        meta === '' ? '' : `<p class="meta">${meta}</p>`,
        `<p>${escapeHtml(item.summary)}</p>`,
        item.whyUseful === '' ? '' : `<p class="why">${escapeHtml(item.whyUseful)}</p>`,
        '</article>',
      ].filter((line) => line !== '').join('\n')
    })

  const html = [
    '<!doctype html>',
    '<html lang="ru">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // No script may run, and nothing may be fetched from anywhere.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(input.title)}</title>`,
    `<style>${BASE_STYLE}${operatorStyle}</style>`,
    '</head>',
    '<body>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<p class="period">${escapeHtml(input.period)}</p>`,
    ...articles,
    '</body>',
    '</html>',
    '',
  ].join('\n')

  return styleRefusal === undefined ? { html } : { html, styleRefusal }
}

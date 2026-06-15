import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  codeBlock,
  bar,
  fitBody,
  TELEGRAM_TEXT_LIMIT,
} from './render.js'

describe('escapeHtml', () => {
  it('escapes the three HTML-special characters', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('escapes ampersand before angle brackets (no double-escaping)', () => {
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;')
  })

  it('leaves safe text untouched', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })
})

describe('codeBlock', () => {
  it('wraps and escapes content', () => {
    expect(codeBlock('a < b')).toBe('<pre><code>a &lt; b</code></pre>')
  })

  it('adds a language class when given', () => {
    expect(codeBlock('x', 'ts')).toBe(
      '<pre><code class="language-ts">x</code></pre>',
    )
  })
})

describe('bar', () => {
  it('renders empty at 0', () => {
    expect(bar(0, 10)).toBe('░'.repeat(10))
  })

  it('renders full at 1', () => {
    expect(bar(1, 10)).toBe('█'.repeat(10))
  })

  it('clamps out-of-range and non-finite input', () => {
    expect(bar(2, 10)).toBe('█'.repeat(10))
    expect(bar(-1, 10)).toBe('░'.repeat(10))
    expect(bar(NaN, 10)).toBe('░'.repeat(10))
  })

  it('rounds the filled portion', () => {
    expect(bar(0.43, 20)).toBe('█'.repeat(9) + '░'.repeat(11))
  })
})

describe('fitBody', () => {
  it('escapes and returns short bodies inline with no document', () => {
    const r = fitBody('a < b')
    expect(r.text).toBe('a &lt; b')
    expect(r.document).toBeUndefined()
  })

  it('offloads overflow to a document and truncates inline with a marker', () => {
    const long = 'x'.repeat(TELEGRAM_TEXT_LIMIT + 100)
    const r = fitBody(long, { filename: 'log.txt' })
    expect(r.document).toBeDefined()
    expect(r.document?.filename).toBe('log.txt')
    expect(r.document?.content).toBe(long)
    expect(r.text.endsWith('… (полностью — в файле)')).toBe(true)
    // inline visible length stays within the limit
    expect(r.text.replace(/&[a-z]+;/g, ' ').length).toBeLessThanOrEqual(
      TELEGRAM_TEXT_LIMIT,
    )
  })

  it('uses a default filename for overflow', () => {
    const r = fitBody('y'.repeat(TELEGRAM_TEXT_LIMIT + 1))
    expect(r.document?.filename).toBe('output.txt')
  })
})

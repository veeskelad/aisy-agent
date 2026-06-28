import { describe, it, expect } from 'vitest'
import { htmlToText, parseDuckDuckGo, isPublicHttpUrl } from './web-tools.js'

// ---------------------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------------------

describe('htmlToText', () => {
  it('removes tags and returns plain text', () => {
    const result = htmlToText('<h1>Hello</h1><p>World</p>')
    expect(result).toContain('Hello')
    expect(result).toContain('World')
    expect(result).not.toContain('<')
    expect(result).not.toContain('>')
  })

  it('strips <script> blocks and their content', () => {
    const result = htmlToText('<p>keep</p><script>alert("evil")</script><p>this</p>')
    expect(result).toContain('keep')
    expect(result).toContain('this')
    expect(result).not.toContain('alert')
    expect(result).not.toContain('evil')
  })

  it('strips <style> blocks and their content', () => {
    const result = htmlToText('<p>visible</p><style>.x { color: red }</style>')
    expect(result).toContain('visible')
    expect(result).not.toContain('color')
  })

  it('strips <head> blocks and their content', () => {
    const result = htmlToText('<head><title>Secret Title</title><meta charset="utf-8"></head><body>Body text</body>')
    expect(result).toContain('Body text')
    expect(result).not.toContain('Secret Title')
  })

  it('decodes &amp;', () => {
    expect(htmlToText('AT&amp;T')).toBe('AT&T')
  })

  it('decodes &lt; and &gt;', () => {
    const r = htmlToText('1 &lt; 2 &gt; 0')
    expect(r).toBe('1 < 2 > 0')
  })

  it('decodes &quot; and &#39;', () => {
    const r = htmlToText('say &quot;hello&quot; and &#39;bye&#39;')
    expect(r).toBe("say \"hello\" and 'bye'")
  })

  it('decodes &nbsp; to a regular space', () => {
    const r = htmlToText('one&nbsp;two')
    expect(r).toBe('one two')
  })

  it('caps output at maxChars and appends the truncation marker', () => {
    const long = '<p>' + 'a'.repeat(200) + '</p>'
    const result = htmlToText(long, 50)
    expect(result.endsWith(' …[truncated]')).toBe(true)
    // First 50 chars should be the 'a' text
    expect(result.startsWith('a'.repeat(50))).toBe(true)
  })

  it('does not append truncation marker when text fits within maxChars', () => {
    const result = htmlToText('<p>short</p>', 1000)
    expect(result).toBe('short')
    expect(result).not.toContain('truncated')
  })

  it('collapses multiple blank lines to at most two newlines', () => {
    const result = htmlToText('<p>a</p>\n\n\n\n\n<p>b</p>')
    expect(result).not.toMatch(/\n{3,}/)
  })
})

// ---------------------------------------------------------------------------
// parseDuckDuckGo
// ---------------------------------------------------------------------------

const DDG_FIXTURE = `
<html><body>
<div class="results">
  <div class="result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc123">
        Example Page Title
      </a>
    </h2>
    <a class="result__snippet" href="#">First result snippet &amp; details here.</a>
  </div>
  <div class="result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.org%2Fdocs">
        Foo Org Docs
      </a>
    </h2>
    <a class="result__snippet">Second result snippet for foo.org.</a>
  </div>
  <div class="result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbar.io">
        Bar IO
      </a>
    </h2>
    <a class="result__snippet">Third snippet.</a>
  </div>
</div>
</body></html>
`

describe('parseDuckDuckGo', () => {
  it('extracts title from result__a links', () => {
    const results = parseDuckDuckGo(DDG_FIXTURE)
    expect(results[0]?.title).toBe('Example Page Title')
    expect(results[1]?.title).toBe('Foo Org Docs')
  })

  it('decodes the uddg redirect param to the real URL', () => {
    const results = parseDuckDuckGo(DDG_FIXTURE)
    expect(results[0]?.url).toBe('https://example.com/page')
    expect(results[1]?.url).toBe('https://foo.org/docs')
  })

  it('extracts snippet text from result__snippet links', () => {
    const results = parseDuckDuckGo(DDG_FIXTURE)
    // Entity decoded in snippet
    expect(results[0]?.snippet).toBe('First result snippet & details here.')
    expect(results[1]?.snippet).toBe('Second result snippet for foo.org.')
  })

  it('respects the limit parameter', () => {
    expect(parseDuckDuckGo(DDG_FIXTURE, 2)).toHaveLength(2)
    expect(parseDuckDuckGo(DDG_FIXTURE, 1)).toHaveLength(1)
  })

  it('returns all results up to limit when fewer exist', () => {
    expect(parseDuckDuckGo(DDG_FIXTURE, 10)).toHaveLength(3)
  })

  it('returns empty array for html with no results', () => {
    expect(parseDuckDuckGo('<html><body>No results found.</body></html>')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// isPublicHttpUrl
// ---------------------------------------------------------------------------

describe('isPublicHttpUrl', () => {
  // Accepted
  it('accepts https://example.com', () => {
    expect(isPublicHttpUrl('https://example.com')).toBe(true)
  })

  it('accepts http:// with a public IP', () => {
    expect(isPublicHttpUrl('http://8.8.8.8')).toBe(true)
  })

  it('accepts a URL with a path and query', () => {
    expect(isPublicHttpUrl('https://example.com/foo?bar=1')).toBe(true)
  })

  // Protocol rejections
  it('rejects ftp:// URLs', () => {
    expect(isPublicHttpUrl('ftp://example.com/file')).toBe(false)
  })

  it('rejects file:// URLs', () => {
    expect(isPublicHttpUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects unparseable strings', () => {
    expect(isPublicHttpUrl('not-a-url')).toBe(false)
  })

  // Bare hostnames
  it('rejects bare hostname "localhost"', () => {
    expect(isPublicHttpUrl('http://localhost')).toBe(false)
  })

  it('rejects bare hostnames without a dot (e.g. "internal")', () => {
    expect(isPublicHttpUrl('http://internal/path')).toBe(false)
  })

  // IPv6 loopback
  it('rejects IPv6 loopback ::1', () => {
    expect(isPublicHttpUrl('http://[::1]/')).toBe(false)
  })

  // IPv4 private ranges
  it('rejects 127.0.0.1 (loopback)', () => {
    expect(isPublicHttpUrl('http://127.0.0.1')).toBe(false)
  })

  it('rejects 127.x.x.x range', () => {
    expect(isPublicHttpUrl('http://127.255.255.255')).toBe(false)
  })

  it('rejects 10.x.x.x (private class A)', () => {
    expect(isPublicHttpUrl('http://10.0.0.1')).toBe(false)
  })

  it('rejects 192.168.x.x (private class C)', () => {
    expect(isPublicHttpUrl('http://192.168.1.100')).toBe(false)
  })

  it('rejects 169.254.x.x (link-local)', () => {
    expect(isPublicHttpUrl('http://169.254.169.254')).toBe(false)
  })

  it('rejects 172.16.x.x (private class B lower)', () => {
    expect(isPublicHttpUrl('http://172.16.0.1')).toBe(false)
  })

  it('rejects 172.31.x.x (private class B upper)', () => {
    expect(isPublicHttpUrl('http://172.31.255.255')).toBe(false)
  })

  it('accepts 172.15.x.x (below private class B range)', () => {
    expect(isPublicHttpUrl('http://172.15.0.1')).toBe(true)
  })

  it('accepts 172.32.x.x (above private class B range)', () => {
    expect(isPublicHttpUrl('http://172.32.0.1')).toBe(true)
  })

  it('rejects 0.0.0.0', () => {
    expect(isPublicHttpUrl('http://0.0.0.0')).toBe(false)
  })
})

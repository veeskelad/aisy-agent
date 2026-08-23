// Pure web-text helpers — no network, no side effects, fully testable in isolation.

/** Strip HTML tags and decode entities from a short fragment (used internally). */
function stripFragmentTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Resolve a DuckDuckGo redirect href to the real URL via the `uddg` param. */
function extractDdgUrl(href: string): string {
  const normalized = href.startsWith('//') ? 'https:' + href : href
  try {
    const m = /[?&]uddg=([^&]*)/.exec(normalized)
    if (m?.[1]) {
      try {
        return decodeURIComponent(m[1])
      } catch {
        return m[1]
      }
    }
    return normalized
  } catch {
    return href
  }
}

/**
 * Convert an HTML page to readable plain text.
 *
 * Strips `<script>`, `<style>`, and `<head>` blocks and their content, removes
 * all remaining tags, decodes the six common HTML entities (&amp; &lt; &gt;
 * &quot; &#39; &nbsp;), collapses whitespace, and caps output at `maxChars`
 * (appending ` …[truncated]` when cut). Pure — no network.
 */
export function htmlToText(html: string, maxChars = 8000): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ \n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + ' …[truncated]'
  }

  return text
}

/**
 * Parse DuckDuckGo HTML-lite search results (`https://html.duckduckgo.com/html/`).
 *
 * Extracts up to `limit` results. Each result has:
 *   - `title`: link text from `<a class="result__a">`
 *   - `url`: real URL decoded from the `uddg` redirect param
 *   - `snippet`: text from the following `<a class="result__snippet">`
 *
 * Pure — no network.
 */
export function parseDuckDuckGo(
  html: string,
  limit = 5,
): { title: string; url: string; snippet: string }[] {
  const results: { title: string; url: string; snippet: string }[] = []

  const aTagRe = /<a(\s[^>]*)>([\s\S]*?)<\/a>/gi
  const links: { href: string; title: string }[] = []
  const snippets: string[] = []

  let m: RegExpExecArray | null
  while ((m = aTagRe.exec(html)) !== null) {
    const attrs = m[1] ?? ''
    const inner = m[2] ?? ''
    if (/\bclass="[^"]*result__a[^"]*"/.test(attrs)) {
      const hrefM = /\bhref="([^"]*)"/.exec(attrs)
      links.push({ href: hrefM?.[1] ?? '', title: stripFragmentTags(inner) })
    } else if (/\bclass="[^"]*result__snippet[^"]*"/.test(attrs)) {
      snippets.push(stripFragmentTags(inner))
    }
  }

  for (let i = 0; i < Math.min(links.length, limit); i++) {
    const link = links[i]
    if (!link) break
    const snippet = snippets[i] ?? ''
    results.push({ title: link.title, url: extractDdgUrl(link.href), snippet })
  }

  return results
}

/**
 * Returns `true` only for http/https URLs whose host is publicly routable.
 *
 * Blocks:
 *  - Non-http/https protocols
 *  - Bare hostnames without a dot (e.g. `localhost`, `internal`)
 *  - 127.0.0.0/8, 10.0.0.0/8, 172.16–31.0.0/12, 192.168.0.0/16, 169.254.0.0/16
 *  - 0.0.0.0, ::1
 *
 * Pure SSRF guard — no network.
 */
export function isPublicHttpUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const host = parsed.hostname.toLowerCase()

  // IPv6 loopback — Node.js URL.hostname returns '[::1]' with brackets
  if (host === '[::1]') return false

  // Bare hostnames: no dots (FQDNs/IPs have dots) and no square brackets (IPv6 has them)
  if (!host.includes('.') && !host.startsWith('[')) return false

  // IPv4 private and special ranges
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0) return false                          // 0.0.0.0/8
    if (a === 10) return false                         // 10.0.0.0/8
    if (a === 127) return false                        // 127.0.0.0/8
    if (a === 169 && b === 254) return false           // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return false  // 172.16.0.0/12
    if (a === 192 && b === 168) return false           // 192.168.0.0/16
  }

  return true
}

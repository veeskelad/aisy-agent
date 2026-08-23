// Reading one page the operator pointed at.
//
// `web_search` already goes out through the pinned egress, but it may only
// reach one host written into the composition. A link someone sends is by
// definition not on a list written in advance, so this module drops the host
// allowlist and keeps every other defence exactly where it was: https only, no
// port, no credentials, DNS pinned to the address the socket actually connects
// to, private and loopback ranges refused, response bounded, deadline enforced.
//
// A redirect is where an allowed host hands you off to one nobody checked, so
// each hop re-runs the whole gauntlet rather than being followed by the HTTP
// client. What comes back is untrusted text: it is quoted to the model, never
// obeyed.

import { isIP } from 'node:net'

import {
  DEFAULT_EGRESS_MAX_RESPONSE_BYTES,
  DEFAULT_EGRESS_TIMEOUT_MS,
  EGRESS_HOST,
  MAX_DNS_ANSWERS,
  egressFailure,
  exactPinnedAddress,
  makeNodePinnedHttpsTransport,
  PinnedHttpsEgressError,
  resolvePublicAddresses,
  snapshotResponse,
  type PinnedAddress,
  type PinnedHttpsTransport,
} from './pinned-https-egress.js'

/** Upper bound on what one page may contribute to the model's context. */
const MAX_READABLE_CHARS = 40_000

export interface FetchedPage {
  /** Where the content actually came from — a redirect chain shows up here. */
  readonly url: string
  readonly contentType: string
  readonly text: string
}

export interface OpenPageFetchInput {
  timeoutMs?: number
  maxResponseBytes?: number
  userAgent?: string
  maxRedirects?: number
  resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly PinnedAddress[]>
  transport?: PinnedHttpsTransport
}

const READABLE_TYPE = /^text\/(?:html|plain)(?:\s*;|$)|^application\/xhtml\+xml(?:\s*;|$)/i

export function makeOpenPageFetch(
  input: OpenPageFetchInput = {},
): (url: string) => Promise<FetchedPage> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_EGRESS_TIMEOUT_MS
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_EGRESS_MAX_RESPONSE_BYTES
  const userAgent = input.userAgent ?? 'aisy-agent'
  const maxRedirects = input.maxRedirects ?? 3
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000 ||
    !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1_024 ||
    maxResponseBytes > 8 * 1024 * 1024 || !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 || maxRedirects > 5 || typeof userAgent !== 'string' ||
    userAgent.length < 1 || userAgent.length > 128 || /[\r\n\0]/.test(userAgent)) {
    throw egressFailure('INVALID_EGRESS_CONFIG')
  }
  const resolve = input.resolve ?? resolvePublicAddresses
  const transport = input.transport ?? makeNodePinnedHttpsTransport()

  const parse = (rawUrl: string): URL => {
    if (typeof rawUrl !== 'string' || rawUrl.length < 1 || rawUrl.length > 8_192) {
      throw egressFailure('EGRESS_URL_DENIED')
    }
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw egressFailure('EGRESS_URL_DENIED')
    }
    // A bare address is not a host: there is no name to resolve, so the DNS
    // pinning that keeps this safe never runs and whatever the URL points at
    // gets dialled directly — including the machine's own network.
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.port !== '' || isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 ||
      !EGRESS_HOST.test(url.hostname)) {
      throw egressFailure('EGRESS_URL_DENIED')
    }
    return url
  }

  return async (rawUrl: string): Promise<FetchedPage> => {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    timer.unref?.()
    try {
      let url = parse(rawUrl)
      const seen = new Set<string>()
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const key = `${url.hostname}${url.pathname}${url.search}`
        if (seen.has(key)) throw egressFailure('EGRESS_URL_DENIED')
        seen.add(key)

        let answers: readonly PinnedAddress[]
        try {
          answers = await resolve(url.hostname, deadline.signal)
        } catch (error) {
          if (deadline.signal.aborted) throw egressFailure('EGRESS_TIMEOUT')
          if (error instanceof PinnedHttpsEgressError) throw error
          throw egressFailure('EGRESS_DNS_FAILED')
        }
        if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_DNS_ANSWERS) {
          throw egressFailure('EGRESS_DNS_FAILED')
        }
        const checked = answers.map(exactPinnedAddress)
        if (checked.some((answer) => answer === null)) throw egressFailure('EGRESS_ADDRESS_DENIED')
        const selected = checked[0]!

        let rawResponse: unknown
        try {
          rawResponse = await transport.get(Object.freeze({
            hostname: url.hostname,
            path: `${url.pathname}${url.search}`,
            address: selected.address,
            family: selected.family,
            servername: url.hostname,
            timeoutMs,
            maxResponseBytes,
            userAgent,
            signal: deadline.signal,
          }))
        } catch (error) {
          if (deadline.signal.aborted) throw egressFailure('EGRESS_TIMEOUT')
          if (error instanceof PinnedHttpsEgressError) throw error
          throw egressFailure('EGRESS_TRANSPORT_FAILED')
        }
        const response = snapshotResponse(rawResponse, maxResponseBytes)

        if (response.status >= 300 && response.status <= 399) {
          if (response.location === undefined || hop === maxRedirects) {
            throw egressFailure('EGRESS_RESPONSE_DENIED')
          }
          // Resolved against the current URL so a relative Location works, then
          // re-parsed by the same rules: a hop may not smuggle in http, a port
          // or credentials.
          url = parse(new URL(response.location, url).toString())
          continue
        }
        if (response.status !== 200) throw egressFailure('EGRESS_RESPONSE_DENIED')
        if (!READABLE_TYPE.test(response.contentType)) {
          throw egressFailure('EGRESS_RESPONSE_DENIED')
        }
        let decoded: string
        try {
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(response.body)
        } catch {
          throw egressFailure('EGRESS_RESPONSE_INVALID')
        }
        return Object.freeze({
          url: url.toString(),
          contentType: response.contentType,
          text: extractReadableText(decoded),
        })
      }
      throw egressFailure('EGRESS_RESPONSE_DENIED')
    } finally {
      clearTimeout(timer)
    }
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
}

/**
 * Strip a page down to what is worth reading. Not a parser and not trying to be:
 * scripts and styles carry no prose and plenty of noise, tags are removed rather
 * than interpreted, and the result is bounded so one page cannot eat the window.
 */
export function extractReadableText(html: string): string {
  const withoutCode = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const text = withoutCode
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d{1,7});/g, (_match, code: string) => {
      const point = Number(code)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' '
    })
    .replace(/&([a-z]+);/gi, (match: string, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
  return text.length <= MAX_READABLE_CHARS
    ? text
    : `${text.slice(0, MAX_READABLE_CHARS)}\n…[страница обрезана]`
}

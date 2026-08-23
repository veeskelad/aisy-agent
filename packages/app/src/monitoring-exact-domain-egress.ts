import type { MonitoringHttpPort, MonitoringStore } from '@aisy/core'

import {
  DEFAULT_EGRESS_MAX_RESPONSE_BYTES,
  DEFAULT_EGRESS_TIMEOUT_MS,
  EGRESS_HOST,
  MAX_DNS_ANSWERS,
  PinnedHttpsEgressError,
  egressFailure,
  exactPinnedAddress,
  makeNodePinnedHttpsTransport,
  resolvePublicAddresses,
  snapshotResponse,
  type PinnedAddress,
  type PinnedHttpsTransport,
} from './pinned-https-egress.js'

const MAX_REDIRECTS = 5
const MONITORING_CONTENT_TYPE = /^(?:text\/(?:html|xml)|application\/(?:xhtml\+xml|xml|rss\+xml|atom\+xml))(?:\s*;|$)/i
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const SECRET_QUERY_KEY = /(?:api[_-]?key|token|secret|password|authorization|credential)/i
const SECRET_QUERY_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{16,}\b|\b[A-Fa-f0-9]{48,}\b|\b[A-Za-z0-9+/_-]{64,}={0,2}\b)/i

function denied(): PinnedHttpsEgressError {
  return egressFailure('EGRESS_URL_DENIED')
}

function exactUrl(raw: string, expectedDomain: string): URL {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 8_192) throw denied()
  let url: URL
  try { url = new URL(raw) } catch { throw denied() }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
    url.port !== '' || url.hash !== '' || url.hostname !== expectedDomain) throw denied()
  for (const [key, value] of url.searchParams) {
    if (SECRET_QUERY_KEY.test(key) || SECRET_QUERY_VALUE.test(value)) throw denied()
  }
  return url
}

/**
 * Monitoring-only network boundary. A request is authorized by one exact
 * persisted source id and its exact HTTPS domain; it never inherits wildcard,
 * subdomain, credential, ambient fetch, or cross-domain redirect authority.
 */
export function makeMonitoringExactDomainHttpPort(input: {
  authority: Pick<MonitoringStore, 'getSourceEgressDomain'>
  timeoutMs?: number
  maxResponseBytes?: number
  userAgent?: string
  resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly PinnedAddress[]>
  transport?: PinnedHttpsTransport
}): MonitoringHttpPort {
  const timeoutMs = input.timeoutMs ?? DEFAULT_EGRESS_TIMEOUT_MS
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_EGRESS_MAX_RESPONSE_BYTES
  const userAgent = input.userAgent ?? 'aisy-monitoring'
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000 ||
    !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1_024 ||
    maxResponseBytes > DEFAULT_EGRESS_MAX_RESPONSE_BYTES ||
    typeof userAgent !== 'string' || userAgent.length < 1 || userAgent.length > 128 ||
    /[\r\n\0]/.test(userAgent)) throw egressFailure('INVALID_EGRESS_CONFIG')
  const resolve = input.resolve ?? resolvePublicAddresses
  const transport = input.transport ?? makeNodePinnedHttpsTransport()
  const grantedDomain = (sourceId: string): string | null => {
    try { return input.authority.getSourceEgressDomain(sourceId) } catch { throw denied() }
  }

  return Object.freeze({
    async get(request: Parameters<MonitoringHttpPort['get']>[0]) {
      if (typeof request !== 'object' || request === null ||
        typeof request.sourceId !== 'string' || request.sourceId.length < 1 ||
        request.sourceId.length > 200 || !Number.isInteger(request.maxBytes) ||
        request.maxBytes < 1 || request.maxBytes > maxResponseBytes) throw denied()
      const sourceId = request.sourceId
      const authorityDomain = grantedDomain(sourceId)
      if (authorityDomain === null || authorityDomain !== authorityDomain.toLowerCase() ||
        !EGRESS_HOST.test(authorityDomain)) throw denied()
      let current = exactUrl(request.url, authorityDomain)
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), timeoutMs)
      timer.unref?.()
      try {
        for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
          // Pause intentionally retains authority. Removal or corrupt legacy
          // state returns null here and revokes before the next network hop.
          if (grantedDomain(sourceId) !== authorityDomain) throw denied()
          let answers: readonly PinnedAddress[]
          try { answers = await resolve(authorityDomain, deadline.signal) } catch (error) {
            if (deadline.signal.aborted) throw egressFailure('EGRESS_TIMEOUT')
            if (error instanceof PinnedHttpsEgressError) throw error
            throw egressFailure('EGRESS_DNS_FAILED')
          }
          if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_DNS_ANSWERS) {
            throw egressFailure('EGRESS_DNS_FAILED')
          }
          const checked = answers.map(exactPinnedAddress)
          if (checked.some((answer) => answer === null)) {
            throw egressFailure('EGRESS_ADDRESS_DENIED')
          }
          const unique = new Set(checked.map((answer) => `${answer!.family}:${answer!.address}`))
          if (unique.size !== checked.length) throw egressFailure('EGRESS_DNS_FAILED')
          const selected = checked[0]!
          if (grantedDomain(sourceId) !== authorityDomain) throw denied()
          let rawResponse: unknown
          try {
            rawResponse = await transport.get(Object.freeze({
              hostname: authorityDomain,
              path: `${current.pathname}${current.search}`,
              address: selected.address,
              family: selected.family,
              servername: authorityDomain,
              timeoutMs,
              maxResponseBytes: request.maxBytes,
              userAgent,
              signal: deadline.signal,
            }))
          } catch (error) {
            if (deadline.signal.aborted) throw egressFailure('EGRESS_TIMEOUT')
            if (error instanceof PinnedHttpsEgressError) throw error
            throw egressFailure('EGRESS_TRANSPORT_FAILED')
          }
          const response = snapshotResponse(rawResponse, request.maxBytes)
          // A delete racing the awaited response must not let the body reach
          // collectors/storage after the grant was revoked.
          if (grantedDomain(sourceId) !== authorityDomain) throw denied()
          if (REDIRECT_STATUS.has(response.status)) {
            if (response.location === undefined || redirect === MAX_REDIRECTS) {
              throw egressFailure('EGRESS_RESPONSE_DENIED')
            }
            let redirected: URL
            try { redirected = new URL(response.location, current) } catch {
              throw egressFailure('EGRESS_RESPONSE_DENIED')
            }
            current = exactUrl(redirected.toString(), authorityDomain)
            continue
          }
          if (response.status === 304) {
            return Object.freeze({ status: 304, body: '', finalUrl: current.toString() })
          }
          if (response.status < 200 || response.status >= 300 ||
            !MONITORING_CONTENT_TYPE.test(response.contentType)) {
            throw egressFailure('EGRESS_RESPONSE_DENIED')
          }
          let body: string
          try { body = new TextDecoder('utf-8', { fatal: true }).decode(response.body) } catch {
            throw egressFailure('EGRESS_RESPONSE_INVALID')
          }
          return Object.freeze({ status: response.status, body, finalUrl: current.toString() })
        }
        throw egressFailure('EGRESS_RESPONSE_DENIED')
      } finally {
        clearTimeout(timer)
      }
    },
  })
}

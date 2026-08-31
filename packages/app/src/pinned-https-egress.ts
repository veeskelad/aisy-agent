import { Resolver } from 'node:dns/promises'
import type { ClientRequest } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { BlockList, isIP, type LookupFunction, type Socket } from 'node:net'
import { types as utilTypes } from 'node:util'

export type PinnedHttpsEgressErrorCode =
  | 'INVALID_EGRESS_CONFIG'
  | 'EGRESS_URL_DENIED'
  | 'EGRESS_QUERY_DENIED'
  | 'EGRESS_DNS_FAILED'
  | 'EGRESS_ADDRESS_DENIED'
  | 'EGRESS_TRANSPORT_FAILED'
  | 'EGRESS_REMOTE_ADDRESS_MISMATCH'
  | 'EGRESS_TIMEOUT'
  | 'EGRESS_RESPONSE_DENIED'
  | 'EGRESS_RESPONSE_TOO_LARGE'
  | 'EGRESS_RESPONSE_INVALID'

export class PinnedHttpsEgressError extends Error {
  constructor(readonly code: PinnedHttpsEgressErrorCode) {
    super(code)
    this.name = 'PinnedHttpsEgressError'
  }
}

export interface PinnedAddress {
  address: string
  family: 4 | 6
}

export interface PinnedHttpsRequest {
  hostname: string
  path: string
  address: string
  family: 4 | 6
  servername: string
  timeoutMs: number
  maxResponseBytes: number
  userAgent: string
  signal: AbortSignal
  /** Absent ⇒ GET. A body is only ever sent with POST. */
  method?: 'GET' | 'POST'
  /**
   * Extra request headers, by name from a fixed allowlist. This is how a
   * service credential travels: never in the URL, where the query already has a
   * secret-shaped-string detector standing guard.
   */
  headers?: Readonly<Record<string, string>>
  /** JSON request body. POST only, bounded. */
  body?: string
}

export interface PinnedHttpsResponse {
  status: number
  contentType: string
  body: Uint8Array
  /** Present only on a redirect; the caller re-runs the full gauntlet on it. */
  location?: string
}

export interface PinnedHttpsTransport {
  get(request: PinnedHttpsRequest): Promise<PinnedHttpsResponse>
}

export const EGRESS_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
export const MAX_DNS_ANSWERS = 16
export const DEFAULT_EGRESS_TIMEOUT_MS = 15_000
export const DEFAULT_EGRESS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** A request body is an API call, not an upload. */
export const MAX_EGRESS_BODY_BYTES = 32 * 1024
/**
 * The only headers this egress will send. `authorization` and `x-api-key` carry
 * a service credential; the other two describe the payload. Anything else — a
 * cookie, a referer, a custom tracking header — is a channel nobody asked for.
 */
const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'authorization', 'x-api-key', 'content-type', 'accept',
])
const HEADER_NAME = /^[a-z][a-z0-9-]{0,63}$/
const SECRET_LIKE_QUERY = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+|\b(?:sk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{16,}\b|\b[A-Fa-f0-9]{48,}\b|\b[A-Za-z0-9+/_-]{64,}={0,2}\b)/i

const deniedIpv4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) deniedIpv4.addSubnet(address, prefix, 'ipv4')

const deniedIpv6 = new BlockList()
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) deniedIpv6.addSubnet(address, prefix, 'ipv6')

export function egressFailure(code: PinnedHttpsEgressErrorCode): PinnedHttpsEgressError {
  return new PinnedHttpsEgressError(code)
}

/**
 * Header validation lives in the transport because both callers pass through
 * it: a name off the allowlist, or a value carrying CR/LF, is a request-
 * splitting attempt and never reaches the socket. Returns lowercase names.
 */
export function checkedEgressHeaders(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({})
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw egressFailure('INVALID_EGRESS_CONFIG')
  }
  const checked: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.toLowerCase()
    if (!HEADER_NAME.test(name) || !ALLOWED_REQUEST_HEADERS.has(name) ||
      Object.hasOwn(checked, name)) throw egressFailure('INVALID_EGRESS_CONFIG')
    if (typeof rawValue !== 'string' || rawValue.length < 1 || rawValue.length > 1_024 ||
      /[\u0000-\u001f\u007f]/.test(rawValue)) throw egressFailure('INVALID_EGRESS_CONFIG')
    checked[name] = rawValue
  }
  return Object.freeze(checked)
}

export function isPublicEgressAddress(address: string, family: 4 | 6): boolean {
  if (address.includes('%') || isIP(address) !== family) return false
  return family === 4
    ? !deniedIpv4.check(address, 'ipv4')
    : !deniedIpv6.check(address, 'ipv6')
}

function encodedSearchQuery(query: string): string {
  if (typeof query !== 'string' || query.trim().length < 1 ||
    Buffer.byteLength(query, 'utf8') > 512 || /[\u0000-\u001f\u007f]/.test(query) ||
    SECRET_LIKE_QUERY.test(query)) throw egressFailure('EGRESS_QUERY_DENIED')
  return encodeURIComponent(query)
}

export function pinnedBingSearchUrl(query: string): string {
  return `https://www.bing.com/search?format=rss&q=${encodedSearchQuery(query)}`
}

export function exactPinnedAddress(value: unknown): PinnedAddress | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || typeof record.address !== 'string' ||
    (record.family !== 4 && record.family !== 6)) return null
  return isPublicEgressAddress(record.address, record.family)
    ? Object.freeze({ address: record.address, family: record.family })
    : null
}

export function snapshotResponse(
  value: unknown,
  maxResponseBytes: number,
): PinnedHttpsResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw egressFailure('EGRESS_RESPONSE_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors).length
  if (keys !== 3 && keys !== 4) throw egressFailure('EGRESS_RESPONSE_INVALID')
  const status = descriptors.status
  const contentType = descriptors.contentType
  const body = descriptors.body
  const location = descriptors.location
  const statusValue: unknown = status?.value
  const contentTypeValue: unknown = contentType?.value
  const bodyValue: unknown = body?.value
  const locationValue: unknown = location?.value
  if ((keys === 4 && location === undefined) ||
    location?.get !== undefined || location?.set !== undefined ||
    (locationValue !== undefined && (typeof locationValue !== 'string' ||
      locationValue.length < 1 || locationValue.length > 2_048 ||
      /[\u0000-\u001f\u007f]/.test(locationValue))) ||
    status?.get !== undefined || status?.set !== undefined ||
    contentType?.get !== undefined || contentType?.set !== undefined ||
    body?.get !== undefined || body?.set !== undefined ||
    typeof statusValue !== 'number' || !Number.isInteger(statusValue) ||
    statusValue < 100 || statusValue > 599 ||
    typeof contentTypeValue !== 'string' || contentTypeValue.length > 256 ||
    typeof bodyValue !== 'object' || bodyValue === null || utilTypes.isProxy(bodyValue) ||
    !(bodyValue instanceof Uint8Array) ||
    Object.getPrototypeOf(bodyValue) !== Uint8Array.prototype) {
    throw egressFailure('EGRESS_RESPONSE_INVALID')
  }
  if (bodyValue.byteLength > maxResponseBytes) throw egressFailure('EGRESS_RESPONSE_TOO_LARGE')
  const ownedBody = new Uint8Array(bodyValue)
  if (ownedBody.byteLength > maxResponseBytes) throw egressFailure('EGRESS_RESPONSE_TOO_LARGE')
  return Object.freeze({
    status: statusValue,
    contentType: contentTypeValue,
    body: ownedBody,
    ...(typeof locationValue === 'string' ? { location: locationValue } : {}),
  })
}

export async function resolvePublicAddresses(
  hostname: string,
  signal: AbortSignal,
): Promise<readonly PinnedAddress[]> {
  const resolver = new Resolver()
  const cancel = (): void => { resolver.cancel() }
  signal.addEventListener('abort', cancel, { once: true })
  let settled: readonly [
    PromiseSettledResult<readonly string[]>,
    PromiseSettledResult<readonly string[]>,
  ]
  try {
    settled = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ])
  } catch {
    throw egressFailure('EGRESS_DNS_FAILED')
  } finally {
    signal.removeEventListener('abort', cancel)
  }
  if (signal.aborted) throw egressFailure('EGRESS_TIMEOUT')
  const [ipv4, ipv6] = settled
  const answers: PinnedAddress[] = []
  if (ipv4.status === 'fulfilled') {
    for (const address of ipv4.value) answers.push({ address, family: 4 })
  }
  if (ipv6.status === 'fulfilled') {
    for (const address of ipv6.value) answers.push({ address, family: 6 })
  }
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_DNS_ANSWERS) {
    throw egressFailure('EGRESS_DNS_FAILED')
  }
  const unique = new Map<string, PinnedAddress>()
  for (const answer of answers) {
    const pinned = exactPinnedAddress(answer)
    if (pinned === null) throw egressFailure('EGRESS_ADDRESS_DENIED')
    unique.set(`${pinned.family}:${pinned.address}`, pinned)
  }
  if (unique.size !== answers.length) throw egressFailure('EGRESS_DNS_FAILED')
  return Object.freeze([...unique.values()])
}

type HttpsRequestFactory = typeof httpsRequest

export function makeNodePinnedHttpsTransport(input: {
  request?: HttpsRequestFactory
} = {}): PinnedHttpsTransport {
  const request = input.request ?? httpsRequest
  return Object.freeze({
    get(descriptor: PinnedHttpsRequest): Promise<PinnedHttpsResponse> {
      return new Promise((resolve, reject) => {
        let completed = false
        let timedOut = false
        const pinned = new BlockList()
        pinned.addAddress(descriptor.address, descriptor.family === 4 ? 'ipv4' : 'ipv6')
        const lookup: LookupFunction = (_hostname, options, callback) => {
          // Node 22's connection auto-selection calls custom lookup with
          // `all: true`. In that form the callback contract requires an array;
          // returning the legacy address/family tuple makes Node read an
          // undefined address and abort every HTTPS request with
          // ERR_INVALID_IP_ADDRESS before the socket is opened.
          if (options.all === true) {
            callback(null, [Object.freeze({
              address: descriptor.address,
              family: descriptor.family,
            })])
            return
          }
          callback(null, descriptor.address, descriptor.family)
        }
        const method = descriptor.method ?? 'GET'
        let extra: Readonly<Record<string, string>>
        let bodyBytes = 0
        try {
          if (method !== 'GET' && method !== 'POST') throw egressFailure('INVALID_EGRESS_CONFIG')
          extra = checkedEgressHeaders(descriptor.headers)
          if (descriptor.body !== undefined) {
            // A body without POST would be silently dropped by most servers —
            // refusing is clearer than sending a request nobody will read.
            if (method !== 'POST' || typeof descriptor.body !== 'string') {
              throw egressFailure('INVALID_EGRESS_CONFIG')
            }
            bodyBytes = Buffer.byteLength(descriptor.body, 'utf8')
            if (bodyBytes > MAX_EGRESS_BODY_BYTES) throw egressFailure('INVALID_EGRESS_CONFIG')
          }
        } catch (error) {
          reject(error instanceof PinnedHttpsEgressError
            ? error
            : egressFailure('INVALID_EGRESS_CONFIG'))
          return
        }
        const options: RequestOptions = {
          protocol: 'https:',
          hostname: descriptor.hostname,
          servername: descriptor.servername,
          port: 443,
          method,
          path: descriptor.path,
          agent: false,
          rejectUnauthorized: true,
          maxHeaderSize: 32 * 1024,
          lookup,
          headers: {
            accept: 'text/html,application/xhtml+xml;q=0.9',
            'accept-encoding': 'identity',
            connection: 'close',
            'user-agent': descriptor.userAgent,
            // The caller's headers win over the defaults above — that is how a
            // JSON call replaces `accept` — but they can only be names from
            // the allowlist, and never `user-agent` or `connection`.
            ...extra,
            ...(descriptor.body === undefined ? {} : { 'content-length': String(bodyBytes) }),
          },
        }
        const finish = (error?: PinnedHttpsEgressError, value?: PinnedHttpsResponse): void => {
          if (completed) return
          completed = true
          descriptor.signal.removeEventListener('abort', abort)
          if (error) reject(error)
          else if (value) resolve(value)
          else reject(egressFailure('EGRESS_TRANSPORT_FAILED'))
        }
        const abort = (): void => {
          requestHandle.destroy()
          finish(timedOut ? egressFailure('EGRESS_TIMEOUT') : egressFailure('EGRESS_TRANSPORT_FAILED'))
        }
        let requestHandle: ClientRequest
        try {
          requestHandle = request(options, (response) => {
            // A redirect legitimately carries no content type; only the status
            // line is mandatory for a response to be usable at all.
            const rawContentType = response.headers['content-type']
            const contentType = typeof rawContentType === 'string' ? rawContentType : ''
            const rawLocation = response.headers['location']
            const location = typeof rawLocation === 'string' && rawLocation.length > 0 &&
              rawLocation.length <= 2_048 && !/[\u0000-\u001f\u007f]/.test(rawLocation)
              ? rawLocation
              : undefined
            if (typeof response.statusCode !== 'number') {
              response.destroy()
              finish(egressFailure('EGRESS_RESPONSE_INVALID'))
              return
            }
            const chunks: Buffer[] = []
            let bytes = 0
            response.on('data', (chunk: Buffer | string) => {
              if (completed) return
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              bytes += buffer.byteLength
              if (bytes > descriptor.maxResponseBytes) {
                response.destroy()
                requestHandle.destroy()
                finish(egressFailure('EGRESS_RESPONSE_TOO_LARGE'))
                return
              }
              chunks.push(buffer)
            })
            response.once('end', () => {
              if (completed) return
              const body = new Uint8Array(Buffer.concat(chunks, bytes))
              requestHandle.destroy()
              finish(undefined, Object.freeze({
                status: response.statusCode!,
                contentType,
                body,
                ...(location === undefined ? {} : { location }),
              }))
            })
            response.once('error', () => {
              requestHandle.destroy()
              finish(egressFailure('EGRESS_TRANSPORT_FAILED'))
            })
            response.once('aborted', () => {
              requestHandle.destroy()
              finish(egressFailure('EGRESS_TRANSPORT_FAILED'))
            })
            response.once('close', () => {
              if (!response.complete) {
                requestHandle.destroy()
                finish(egressFailure('EGRESS_TRANSPORT_FAILED'))
              }
            })
          })
        } catch {
          finish(egressFailure('EGRESS_TRANSPORT_FAILED'))
          return
        }
        requestHandle.once('socket', (socket: Socket) => {
          socket.once('secureConnect', () => {
            const remoteAddress = socket.remoteAddress
            const remoteFamily = socket.remoteFamily === 'IPv6' ? 'ipv6' : 'ipv4'
            if (typeof remoteAddress !== 'string' || !pinned.check(remoteAddress, remoteFamily)) {
              requestHandle.destroy()
              finish(egressFailure('EGRESS_REMOTE_ADDRESS_MISMATCH'))
            }
          })
        })
        requestHandle.once('error', () => finish(
          timedOut ? egressFailure('EGRESS_TIMEOUT') : egressFailure('EGRESS_TRANSPORT_FAILED'),
        ))
        requestHandle.once('close', () => finish(
          timedOut ? egressFailure('EGRESS_TIMEOUT') : egressFailure('EGRESS_TRANSPORT_FAILED'),
        ))
        requestHandle.setTimeout(descriptor.timeoutMs, () => {
          timedOut = true
          requestHandle.destroy()
          finish(egressFailure('EGRESS_TIMEOUT'))
        })
        descriptor.signal.addEventListener('abort', abort, { once: true })
        if (descriptor.signal.aborted) abort()
        else if (descriptor.body === undefined) requestHandle.end()
        else requestHandle.end(descriptor.body, 'utf8')
      })
    },
  })
}

export function makePinnedHttpsTextGet(input: {
  allowedHosts: readonly string[]
  timeoutMs?: number
  maxResponseBytes?: number
  userAgent?: string
  resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly PinnedAddress[]>
  transport?: PinnedHttpsTransport
}): (url: string) => Promise<string> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_EGRESS_TIMEOUT_MS
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_EGRESS_MAX_RESPONSE_BYTES
  const userAgent = input.userAgent ?? 'aisy-agent'
  if (!Array.isArray(input.allowedHosts) || input.allowedHosts.length < 1 ||
    input.allowedHosts.length > 32 || !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 || timeoutMs > 120_000 || !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1_024 || maxResponseBytes > 8 * 1024 * 1024 ||
    typeof userAgent !== 'string' || userAgent.length < 1 || userAgent.length > 128 ||
    /[\r\n\0]/.test(userAgent)) throw egressFailure('INVALID_EGRESS_CONFIG')
  const allowedHosts = new Set<string>()
  for (const host of input.allowedHosts) {
    if (typeof host !== 'string' || host !== host.toLowerCase() || !EGRESS_HOST.test(host) ||
      allowedHosts.has(host)) throw egressFailure('INVALID_EGRESS_CONFIG')
    allowedHosts.add(host)
  }
  const resolve = input.resolve ?? resolvePublicAddresses
  const transport = input.transport ?? makeNodePinnedHttpsTransport()

  return async (rawUrl: string): Promise<string> => {
    if (typeof rawUrl !== 'string' || rawUrl.length < 1 || rawUrl.length > 8_192) {
      throw egressFailure('EGRESS_URL_DENIED')
    }
    let url: URL
    try { url = new URL(rawUrl) } catch { throw egressFailure('EGRESS_URL_DENIED') }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.port !== '' || url.hash !== '' || !allowedHosts.has(url.hostname)) {
      throw egressFailure('EGRESS_URL_DENIED')
    }
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    timer.unref?.()
    try {
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
      const unique = new Set(checked.map((answer) => `${answer!.family}:${answer!.address}`))
      if (unique.size !== checked.length) throw egressFailure('EGRESS_DNS_FAILED')
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
      if (response.status !== 200) throw egressFailure('EGRESS_RESPONSE_DENIED')
      if (!/^text\/(?:html|xml)(?:\s*;|$)|^application\/(?:xhtml\+xml|rss\+xml)(?:\s*;|$)/i
        .test(response.contentType)) {
        throw egressFailure('EGRESS_RESPONSE_DENIED')
      }
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(response.body)
      } catch {
        throw egressFailure('EGRESS_RESPONSE_INVALID')
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface PinnedJsonCall {
  url: string
  method?: 'GET' | 'POST'
  /** Names from the allowlist only; this is where a service credential goes. */
  headers?: Readonly<Record<string, string>>
  /** Serialized by the caller, so the exact bytes on the wire are visible here. */
  body?: string
}

/**
 * The same gauntlet as `makePinnedHttpsTextGet`, answering JSON instead of HTML.
 * This is what a service API needs: a method, an `Authorization` header, and a
 * body — none of which the text getter could carry. The credential travels in a
 * header and never in the URL: query strings end up in logs, and this module
 * already refuses secret-shaped queries outright.
 *
 * A redirect is not followed here. A search or scrape API answering 3xx is a
 * broken endpoint, not a redirect worth chasing across hosts.
 */
export function makePinnedHttpsJson(input: {
  allowedHosts: readonly string[]
  timeoutMs?: number
  maxResponseBytes?: number
  userAgent?: string
  resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly PinnedAddress[]>
  transport?: PinnedHttpsTransport
}): (call: PinnedJsonCall) => Promise<unknown> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_EGRESS_TIMEOUT_MS
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_EGRESS_MAX_RESPONSE_BYTES
  const userAgent = input.userAgent ?? 'aisy-agent'
  if (!Array.isArray(input.allowedHosts) || input.allowedHosts.length < 1 ||
    input.allowedHosts.length > 32 || !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 || timeoutMs > 120_000 || !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1_024 || maxResponseBytes > 8 * 1024 * 1024 ||
    typeof userAgent !== 'string' || userAgent.length < 1 || userAgent.length > 128 ||
    /[\r\n\0]/.test(userAgent)) throw egressFailure('INVALID_EGRESS_CONFIG')
  const allowedHosts = new Set<string>()
  for (const host of input.allowedHosts) {
    if (typeof host !== 'string' || host !== host.toLowerCase() || !EGRESS_HOST.test(host) ||
      allowedHosts.has(host)) throw egressFailure('INVALID_EGRESS_CONFIG')
    allowedHosts.add(host)
  }
  const resolve = input.resolve ?? resolvePublicAddresses
  const transport = input.transport ?? makeNodePinnedHttpsTransport()

  return async (call: PinnedJsonCall): Promise<unknown> => {
    if (typeof call !== 'object' || call === null) throw egressFailure('EGRESS_URL_DENIED')
    const rawUrl = call.url
    if (typeof rawUrl !== 'string' || rawUrl.length < 1 || rawUrl.length > 8_192) {
      throw egressFailure('EGRESS_URL_DENIED')
    }
    let url: URL
    try { url = new URL(rawUrl) } catch { throw egressFailure('EGRESS_URL_DENIED') }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      url.port !== '' || url.hash !== '' || !allowedHosts.has(url.hostname)) {
      throw egressFailure('EGRESS_URL_DENIED')
    }
    // A credential belongs in a header. If one shows up in the query — a caller
    // built the URL by hand — the call stops here rather than being logged by
    // the far end.
    if (url.search.length > 0 && SECRET_LIKE_QUERY.test(decodeURIComponent(url.search))) {
      throw egressFailure('EGRESS_QUERY_DENIED')
    }
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    timer.unref?.()
    try {
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
      const unique = new Set(checked.map((answer) => `${answer!.family}:${answer!.address}`))
      if (unique.size !== checked.length) throw egressFailure('EGRESS_DNS_FAILED')
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
          method: call.method ?? 'GET',
          headers: Object.freeze({
            accept: 'application/json',
            ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(call.headers ?? {}),
          }),
          ...(call.body === undefined ? {} : { body: call.body }),
        }))
      } catch (error) {
        if (deadline.signal.aborted) throw egressFailure('EGRESS_TIMEOUT')
        if (error instanceof PinnedHttpsEgressError) throw error
        throw egressFailure('EGRESS_TRANSPORT_FAILED')
      }
      const response = snapshotResponse(rawResponse, maxResponseBytes)
      if (response.status !== 200) throw egressFailure('EGRESS_RESPONSE_DENIED')
      if (!/^application\/json(?:\s*;|$)/i.test(response.contentType)) {
        throw egressFailure('EGRESS_RESPONSE_DENIED')
      }
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body))
      } catch {
        throw egressFailure('EGRESS_RESPONSE_INVALID')
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

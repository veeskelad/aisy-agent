import { isIP } from 'node:net'

/** First version with gw-priority plus the docker-cp security fixes used by ADR-0066. */
export const RESTRICTED_CLONE_MIN_DOCKER_VERSION = '29.5.2' as const

const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/
const DOCKER_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

export function isRestrictedCloneImageDigest(value: string): boolean {
  return value.length <= 512 && IMAGE_DIGEST.test(value)
}

export function isRestrictedCloneDockerVersionCompatible(value: string): boolean {
  const actual = DOCKER_VERSION.exec(value.trim())
  const minimum = DOCKER_VERSION.exec(RESTRICTED_CLONE_MIN_DOCKER_VERSION)
  if (actual === null || minimum === null) return false
  for (let index = 1; index <= 3; index += 1) {
    const component = Number(actual[index])
    const required = Number(minimum[index])
    if (!Number.isSafeInteger(component) || !Number.isSafeInteger(required)) return false
    if (component > required) return true
    if (component < required) return false
  }
  return true
}

export interface RestrictedCloneDnsAnswer {
  readonly address: string
  readonly family: 4 | 6
}

export interface RestrictedCloneDnsPort {
  resolve(hostname: string, signal?: AbortSignal): Promise<readonly RestrictedCloneDnsAnswer[]>
}

export interface RestrictedCloneTarget {
  readonly url: string
  readonly hostname: string
  readonly port: 443
  readonly addresses: readonly RestrictedCloneDnsAnswer[]
  readonly transportPolicy: Readonly<{
    connectOnlyToReviewedAddresses: true
    preserveTlsServerName: true
    followRedirects: false
  }>
}

export type RestrictedCloneTargetErrorCode =
  | 'CLONE_URL_INVALID'
  | 'CLONE_URL_HTTPS_REQUIRED'
  | 'CLONE_URL_CREDENTIALS_DENIED'
  | 'CLONE_URL_PORT_DENIED'
  | 'CLONE_URL_QUERY_DENIED'
  | 'CLONE_URL_FRAGMENT_DENIED'
  | 'CLONE_URL_HOST_DENIED'
  | 'CLONE_URL_PATH_DENIED'
  | 'CLONE_DNS_LOOKUP_FAILED'
  | 'CLONE_DNS_RESPONSE_DENIED'
  | 'CLONE_TARGET_NOT_PUBLIC'
  | 'CLONE_TARGET_RESOLUTION_CANCELLED'

export class RestrictedCloneTargetError extends Error {
  constructor(public readonly code: RestrictedCloneTargetErrorCode) {
    super(code)
    this.name = 'RestrictedCloneTargetError'
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MAX_URL_LENGTH = 2_048
const MAX_DNS_ANSWERS = 16

type Prefix = readonly [address: string, bits: number]

const DENIED_IPV4_PREFIXES: readonly Prefix[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

const DENIED_IPV6_PREFIXES: readonly Prefix[] = [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]

const PUBLIC_IPV6_PREFIX: Prefix = ['2000::', 3]

function parseIpv4(address: string): Uint8Array | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const bytes = parts.map((part) => Number(part))
  if (bytes.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 ||
    String(part) !== parts[index])) return undefined
  return Uint8Array.from(bytes)
}

function expandEmbeddedIpv4(address: string): string | undefined {
  if (!address.includes('.')) return address
  const separator = address.lastIndexOf(':')
  if (separator < 0) return undefined
  const ipv4 = parseIpv4(address.slice(separator + 1))
  if (ipv4 === undefined) return undefined
  const [first, second, third, fourth] = ipv4
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return undefined
  }
  const high = ((first << 8) | second).toString(16)
  const low = ((third << 8) | fourth).toString(16)
  return `${address.slice(0, separator + 1)}${high}:${low}`
}

function parseIpv6(address: string): Uint8Array | undefined {
  if (address.includes('%')) return undefined
  const expandedIpv4 = expandEmbeddedIpv4(address.toLowerCase())
  if (expandedIpv4 === undefined || expandedIpv4.split('::').length > 2) return undefined
  const hasCompression = expandedIpv4.includes('::')
  const [leftRaw = '', rightRaw = ''] = expandedIpv4.split('::')
  const left = leftRaw === '' ? [] : leftRaw.split(':')
  const right = rightRaw === '' ? [] : rightRaw.split(':')
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return undefined
  const missing = 8 - left.length - right.length
  if ((!hasCompression && missing !== 0) || (hasCompression && missing < 1)) return undefined
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (words.length !== 8) return undefined
  const bytes = new Uint8Array(16)
  words.forEach((word, index) => {
    const value = Number.parseInt(word, 16)
    bytes[index * 2] = value >>> 8
    bytes[index * 2 + 1] = value & 0xff
  })
  return bytes
}

function parseIp(address: string): Uint8Array | undefined {
  const family = isIP(address)
  if (family === 4) return parseIpv4(address)
  if (family === 6) return parseIpv6(address)
  return undefined
}

function matchesPrefix(address: Uint8Array, network: Uint8Array, bits: number): boolean {
  if (address.length !== network.length) return false
  const fullBytes = Math.floor(bits / 8)
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== network[index]) return false
  }
  const remaining = bits % 8
  if (remaining === 0) return true
  const mask = 0xff << (8 - remaining)
  const addressByte = address[fullBytes]
  const networkByte = network[fullBytes]
  return addressByte !== undefined && networkByte !== undefined &&
    (addressByte & mask) === (networkByte & mask)
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
  if (isIP(address) !== family) return false
  const bytes = parseIp(address)
  if (bytes === undefined) return false
  const denied = family === 4 ? DENIED_IPV4_PREFIXES : DENIED_IPV6_PREFIXES
  const isDenied = denied.some(([network, bits]) => {
    const networkBytes = parseIp(network)
    return networkBytes !== undefined && matchesPrefix(bytes, networkBytes, bits)
  })
  if (isDenied || family === 4) return !isDenied
  const [publicNetwork, publicBits] = PUBLIC_IPV6_PREFIX
  const publicBytes = parseIp(publicNetwork)
  return publicBytes !== undefined && matchesPrefix(bytes, publicBytes, publicBits)
}

/** Defense-in-depth validator for transports that receive a typed target from another module. */
export function isPublicRestrictedCloneAddress(answer: RestrictedCloneDnsAnswer): boolean {
  return (answer.family === 4 || answer.family === 6) &&
    isIP(answer.address) === answer.family && isPublicAddress(answer.address, answer.family)
}

function cleanHostname(url: URL): { hostname: string; literal?: RestrictedCloneDnsAnswer } {
  const raw = url.hostname
  const unwrapped = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  const family = isIP(unwrapped)
  if (family === 4 || family === 6) {
    const literal = { address: unwrapped, family } as const
    if (!isPublicAddress(literal.address, literal.family)) {
      throw new RestrictedCloneTargetError('CLONE_TARGET_NOT_PUBLIC')
    }
    return { hostname: unwrapped, literal }
  }

  const hostname = raw.toLowerCase()
  const labels = hostname.split('.')
  const reservedSuffix = labels.at(-1)
  if (hostname.length === 0 || hostname.length > 253 || hostname.endsWith('.') ||
    labels.some((label) => !HOST_LABEL.test(label)) ||
    reservedSuffix === 'localhost' || reservedSuffix === 'local' ||
    reservedSuffix === 'internal' || reservedSuffix === 'invalid' ||
    reservedSuffix === 'test' || reservedSuffix === 'example' ||
    hostname === 'home.arpa' || hostname.endsWith('.home.arpa')) {
    throw new RestrictedCloneTargetError('CLONE_URL_HOST_DENIED')
  }
  return { hostname }
}

function canonicalUrl(raw: string): { url: URL; hostname: string; literal?: RestrictedCloneDnsAnswer } {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH || raw !== raw.trim() ||
    CONTROL.test(raw) || raw.includes('\\')) {
    throw new RestrictedCloneTargetError('CLONE_URL_INVALID')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RestrictedCloneTargetError('CLONE_URL_INVALID')
  }
  if (url.protocol !== 'https:') {
    throw new RestrictedCloneTargetError('CLONE_URL_HTTPS_REQUIRED')
  }
  if (url.username !== '' || url.password !== '') {
    throw new RestrictedCloneTargetError('CLONE_URL_CREDENTIALS_DENIED')
  }
  if (url.port !== '') throw new RestrictedCloneTargetError('CLONE_URL_PORT_DENIED')
  if (url.search !== '') throw new RestrictedCloneTargetError('CLONE_URL_QUERY_DENIED')
  if (url.hash !== '') throw new RestrictedCloneTargetError('CLONE_URL_FRAGMENT_DENIED')
  if (url.pathname === '/' || /%2f|%5c/i.test(url.pathname)) {
    throw new RestrictedCloneTargetError('CLONE_URL_PATH_DENIED')
  }
  let firstPathComponent: string
  try {
    firstPathComponent = decodeURIComponent(url.pathname.split('/')[1] ?? '')
  } catch {
    throw new RestrictedCloneTargetError('CLONE_URL_PATH_DENIED')
  }
  if (firstPathComponent.length === 0 || firstPathComponent.startsWith('-') ||
    CONTROL.test(firstPathComponent)) {
    throw new RestrictedCloneTargetError('CLONE_URL_PATH_DENIED')
  }
  const target = cleanHostname(url)
  return { url, ...target }
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new RestrictedCloneTargetError('CLONE_TARGET_RESOLUTION_CANCELLED')
  }
}

export async function resolveRestrictedCloneTarget(input: {
  url: string
  dns: RestrictedCloneDnsPort
  signal?: AbortSignal
}): Promise<RestrictedCloneTarget> {
  cancelled(input.signal)
  const parsed = canonicalUrl(input.url)
  let answers: readonly RestrictedCloneDnsAnswer[]
  if (parsed.literal !== undefined) {
    answers = [parsed.literal]
  } else {
    try {
      answers = await input.dns.resolve(parsed.hostname, input.signal)
    } catch {
      cancelled(input.signal)
      throw new RestrictedCloneTargetError('CLONE_DNS_LOOKUP_FAILED')
    }
  }
  cancelled(input.signal)
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > MAX_DNS_ANSWERS) {
    throw new RestrictedCloneTargetError('CLONE_DNS_RESPONSE_DENIED')
  }

  const seen = new Set<string>()
  const reviewed = answers.map((answer) => {
    if ((answer.family !== 4 && answer.family !== 6) || isIP(answer.address) !== answer.family) {
      throw new RestrictedCloneTargetError('CLONE_DNS_RESPONSE_DENIED')
    }
    const bytes = parseIp(answer.address)
    if (bytes === undefined) throw new RestrictedCloneTargetError('CLONE_DNS_RESPONSE_DENIED')
    const identity = `${answer.family}:${Buffer.from(bytes).toString('hex')}`
    if (seen.has(identity)) throw new RestrictedCloneTargetError('CLONE_DNS_RESPONSE_DENIED')
    seen.add(identity)
    if (!isPublicAddress(answer.address, answer.family)) {
      throw new RestrictedCloneTargetError('CLONE_TARGET_NOT_PUBLIC')
    }
    return Object.freeze({ address: answer.address, family: answer.family })
  })

  return Object.freeze({
    url: parsed.url.href,
    hostname: parsed.hostname,
    port: 443 as const,
    addresses: Object.freeze(reviewed),
    transportPolicy: Object.freeze({
      connectOnlyToReviewedAddresses: true as const,
      preserveTlsServerName: true as const,
      followRedirects: false as const,
    }),
  })
}

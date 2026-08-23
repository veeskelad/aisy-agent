import type {
  OpaqueCredentialByteTransportPort,
  OpaqueCredentialDescriptorV1,
  OpaqueCredentialLocatorV1,
  OpaqueProxyTransportAttestationV1,
  OpaqueSecretBackendAttestationV1,
  OpaqueSecretBackendPort,
} from '@aisy/core'

export type OpaqueSecretBackendId =
  | 'macos-keychain'
  | 'linux-libsecret'
  | 'vault-agent'

export type OpaqueSecretTrustRoot = 'private-os' | 'external'

export interface OpaqueSecretBackendProcessAttestationV1 {
  readonly schemaVersion: 1
  readonly status: 'trusted'
  readonly backendId: OpaqueSecretBackendId
  readonly policyRevision: string
  readonly trustRoot: OpaqueSecretTrustRoot
  readonly secretResolution: 'callback-only'
  readonly binding: 'exact'
  readonly deletion: 'confirmed'
  readonly plaintextFallback: 'disabled'
}

export interface OpaqueSecretAttestBackendOperation {
  readonly operation: 'attest-backend'
  readonly backendId: OpaqueSecretBackendId
  readonly policyRevision: string
}

export interface OpaqueSecretResolveActiveOperation {
  readonly operation: 'resolve-active'
  readonly backendId: OpaqueSecretBackendId
  readonly policyRevision: string
  readonly locator: Readonly<OpaqueCredentialLocatorV1>
}

export type OpaqueSecretProcessOperation =
  | OpaqueSecretAttestBackendOperation
  | OpaqueSecretResolveActiveOperation

export interface OpaqueSecretResolveActiveResultV1 {
  readonly schemaVersion: 1
  readonly status: 'resolved'
  readonly locator: Readonly<OpaqueCredentialLocatorV1>
  readonly secret: Uint8Array
}

/**
 * Deliberately narrower than a child-process API. The implementation owns the
 * executable, arguments, environment and backend-specific command protocol.
 */
export interface OpaqueSecretProcessPort {
  run(operation: Readonly<OpaqueSecretProcessOperation>, signal: AbortSignal): Promise<unknown>
}

export interface OpaqueByteProxyProcessAttestationV1 extends OpaqueProxyTransportAttestationV1 {
  readonly isolation: 'isolated-one-shot-byte-proxy'
}

export interface OpaqueByteProxyAttestTransportOperation {
  readonly operation: 'attest-transport'
  readonly transportId: string
  readonly policyRevision: string
}

export interface OpaqueByteProxyExchangeOperation {
  readonly operation: 'exchange'
  readonly requestId: string
  readonly descriptor: Readonly<OpaqueCredentialDescriptorV1>
  readonly authorization: Uint8Array
  readonly body: Uint8Array | null
}

export type OpaqueByteProxyProcessOperation =
  | OpaqueByteProxyAttestTransportOperation
  | OpaqueByteProxyExchangeOperation

/**
 * The injected implementation performs one fixed, isolated byte exchange. It
 * cannot be instructed to run a command or accept a caller-built URL/header.
 */
export interface OpaqueByteProxyProcessPort {
  run(operation: Readonly<OpaqueByteProxyProcessOperation>, signal: AbortSignal): Promise<unknown>
}

export type OpaqueProcessAdapterErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'BACKEND_ATTESTATION_FAILED'
  | 'BACKEND_ATTESTATION_REJECTED'
  | 'BACKEND_RESOLVE_FAILED'
  | 'BACKEND_RESPONSE_REJECTED'
  | 'TRANSPORT_ATTESTATION_FAILED'
  | 'TRANSPORT_ATTESTATION_REJECTED'
  | 'TRANSPORT_EXCHANGE_FAILED'
  | 'TRANSPORT_RESPONSE_REJECTED'

export class OpaqueProcessAdapterError extends Error {
  constructor(public readonly code: OpaqueProcessAdapterErrorCode) {
    super(code)
    this.name = 'OpaqueProcessAdapterError'
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_SECRET_BYTES = 64 * 1024
const MAX_TRANSFER_BYTES = 16 * 1024 * 1024
const MAX_TIMEOUT_MS = 300_000

const BACKEND_TRUST_ROOT = Object.freeze({
  'macos-keychain': 'private-os',
  'linux-libsecret': 'private-os',
  'vault-agent': 'external',
} satisfies Readonly<Record<OpaqueSecretBackendId, OpaqueSecretTrustRoot>>)

const LOCATOR_KEYS = Object.freeze([
  'schemaVersion',
  'handle',
  'operatorId',
  'profileId',
  'connectionId',
  'connectionRevision',
  'provider',
  'providerSlot',
  'credentialRevision',
  'generation',
  'state',
] as const)

const DESCRIPTOR_KEYS = Object.freeze([
  'schemaVersion',
  'descriptorId',
  'descriptorRevision',
  'clientId',
  'provider',
  'providerSlot',
  'origin',
  'method',
  'path',
  'authProtocol',
  'timeoutMs',
  'requestMaxBytes',
  'responseMaxBytes',
  'responseMode',
  'redirects',
] as const)

function fail(code: OpaqueProcessAdapterErrorCode): never {
  throw new OpaqueProcessAdapterError(code)
}

function cleanIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) return fail('INVALID_CONFIGURATION')
  return value
}

function cleanBackendId(value: unknown): OpaqueSecretBackendId {
  if (value !== 'macos-keychain' && value !== 'linux-libsecret' && value !== 'vault-agent') {
    return fail('INVALID_CONFIGURATION')
  }
  return value
}

function exactData(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expectedKeys.length || keys.some((key) =>
      typeof key !== 'string' || !expectedKeys.includes(key))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result = Object.create(null) as Record<string, unknown>
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null
      result[key] = descriptor.value
    }
    return result
  } catch {
    return null
  }
}

function plainBytes(value: unknown): value is Uint8Array {
  try {
    return value instanceof Uint8Array && Object.getPrototypeOf(value) === Uint8Array.prototype
  } catch {
    return false
  }
}

function byteCandidate(value: unknown, key: string): Uint8Array | null {
  try {
    if (typeof value !== 'object' || value === null) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null
    return descriptor.value instanceof Uint8Array ? descriptor.value : null
  } catch {
    return null
  }
}

function zero(value: Uint8Array | null | undefined): void {
  try {
    value?.fill(0)
  } catch {
    // A detached or hostile buffer is rejected elsewhere; never expose its error.
  }
}

function exactLocator(value: unknown): Record<string, unknown> | null {
  const raw = exactData(value, LOCATOR_KEYS)
  if (raw === null || raw['schemaVersion'] !== 1 || raw['state'] !== 'active' ||
    typeof raw['handle'] !== 'string' || raw['handle'].length === 0 ||
    typeof raw['operatorId'] !== 'string' || typeof raw['profileId'] !== 'string' ||
    typeof raw['connectionId'] !== 'string' || typeof raw['connectionRevision'] !== 'string' ||
    (raw['provider'] !== 'openai' && raw['provider'] !== 'anthropic' &&
      raw['provider'] !== 'openrouter') || typeof raw['providerSlot'] !== 'string' ||
    !Number.isSafeInteger(raw['credentialRevision']) || Number(raw['credentialRevision']) < 1 ||
    !Number.isSafeInteger(raw['generation']) || Number(raw['generation']) < 1) return null
  return raw
}

function sameLocator(left: unknown, right: unknown): boolean {
  const leftRaw = exactLocator(left)
  const rightRaw = exactLocator(right)
  return leftRaw !== null && rightRaw !== null &&
    LOCATOR_KEYS.every((key) => leftRaw[key] === rightRaw[key])
}

function validDescriptor(value: unknown): value is Readonly<OpaqueCredentialDescriptorV1> {
  const raw = exactData(value, DESCRIPTOR_KEYS)
  if (raw === null || raw['schemaVersion'] !== 1 ||
    typeof raw['descriptorId'] !== 'string' || !IDENTIFIER.test(raw['descriptorId']) ||
    !Number.isSafeInteger(raw['descriptorRevision']) || Number(raw['descriptorRevision']) < 1 ||
    typeof raw['clientId'] !== 'string' || !IDENTIFIER.test(raw['clientId']) ||
    (raw['provider'] !== 'openai' && raw['provider'] !== 'anthropic' &&
      raw['provider'] !== 'openrouter') || typeof raw['providerSlot'] !== 'string' ||
    raw['providerSlot'].length === 0 || typeof raw['origin'] !== 'string' ||
    !raw['origin'].startsWith('https://') || raw['origin'].length > 2048 ||
    (raw['method'] !== 'GET' && raw['method'] !== 'POST') ||
    typeof raw['path'] !== 'string' || !raw['path'].startsWith('/') || raw['path'].length > 2048 ||
    (raw['authProtocol'] !== 'bearer' &&
      raw['authProtocol'] !== 'anthropic-x-api-key-2023-06-01') ||
    !Number.isSafeInteger(raw['timeoutMs']) || Number(raw['timeoutMs']) < 1 ||
    Number(raw['timeoutMs']) > MAX_TIMEOUT_MS ||
    !Number.isSafeInteger(raw['requestMaxBytes']) || Number(raw['requestMaxBytes']) < 1 ||
    Number(raw['requestMaxBytes']) > MAX_TRANSFER_BYTES ||
    !Number.isSafeInteger(raw['responseMaxBytes']) || Number(raw['responseMaxBytes']) < 1 ||
    Number(raw['responseMaxBytes']) > MAX_TRANSFER_BYTES ||
    raw['responseMode'] !== 'status-only' ||
    raw['redirects'] !== 'deny') return false
  return true
}

function backendAttestation(
  value: unknown,
  backendId: OpaqueSecretBackendId,
  policyRevision: string,
): OpaqueSecretBackendAttestationV1 {
  const raw = exactData(value, [
    'schemaVersion', 'status', 'backendId', 'policyRevision', 'trustRoot',
    'secretResolution', 'binding', 'deletion', 'plaintextFallback',
  ])
  if (raw === null || raw['schemaVersion'] !== 1 || raw['status'] !== 'trusted' ||
    raw['backendId'] !== backendId || raw['policyRevision'] !== policyRevision ||
    raw['trustRoot'] !== BACKEND_TRUST_ROOT[backendId] ||
    raw['secretResolution'] !== 'callback-only' || raw['binding'] !== 'exact' ||
    raw['deletion'] !== 'confirmed' || raw['plaintextFallback'] !== 'disabled') {
    return fail('BACKEND_ATTESTATION_REJECTED')
  }
  return Object.freeze({
    schemaVersion: 1,
    status: 'trusted',
    backendId,
    policyRevision,
    capabilities: Object.freeze([
      'resolve-callback',
      'exact-binding',
      'confirmed-delete',
    ] as const),
  })
}

function transportAttestation(
  value: unknown,
  transportId: string,
  policyRevision: string,
): OpaqueProxyTransportAttestationV1 {
  const raw = exactData(value, [
    'schemaVersion', 'status', 'transportId', 'policyRevision', 'isolation',
    'byteOwnedAuthorization', 'dnsPolicy', 'tlsPolicy', 'redirects',
    'proxyEnvironment', 'connectionReuse', 'bounds',
  ])
  if (raw === null || raw['schemaVersion'] !== 1 || raw['status'] !== 'trusted' ||
    raw['transportId'] !== transportId || raw['policyRevision'] !== policyRevision ||
    raw['isolation'] !== 'isolated-one-shot-byte-proxy' ||
    raw['byteOwnedAuthorization'] !== true ||
    raw['dnsPolicy'] !== 'resolve-public-and-pin' ||
    raw['tlsPolicy'] !== 'exact-hostname-sni-system-ca-tls12' ||
    raw['redirects'] !== 'deny' || raw['proxyEnvironment'] !== 'disabled' ||
    raw['connectionReuse'] !== 'disabled' ||
    raw['bounds'] !== 'request-response-decompressed-chunks') {
    return fail('TRANSPORT_ATTESTATION_REJECTED')
  }
  return Object.freeze({
    schemaVersion: 1,
    status: 'trusted',
    transportId,
    policyRevision,
    byteOwnedAuthorization: true,
    dnsPolicy: 'resolve-public-and-pin',
    tlsPolicy: 'exact-hostname-sni-system-ca-tls12',
    redirects: 'deny',
    proxyEnvironment: 'disabled',
    connectionReuse: 'disabled',
    bounds: 'request-response-decompressed-chunks',
  })
}

export function makeProcessOpaqueSecretBackend(input: Readonly<{
  backendId: OpaqueSecretBackendId
  policyRevision: string
  process: OpaqueSecretProcessPort
}>): OpaqueSecretBackendPort {
  const backendId = cleanBackendId(input.backendId)
  const policyRevision = cleanIdentifier(input.policyRevision)
  const process = input.process

  return Object.freeze<OpaqueSecretBackendPort>({
    async attest(signal) {
      let raw: unknown
      try {
        raw = await process.run(Object.freeze({
          operation: 'attest-backend',
          backendId,
          policyRevision,
        }), signal)
      } catch {
        return fail('BACKEND_ATTESTATION_FAILED')
      }
      return backendAttestation(raw, backendId, policyRevision)
    },

    async withActiveSecret(locator, _capability, consume, signal) {
      let raw: unknown
      try {
        raw = await process.run(Object.freeze({
          operation: 'resolve-active',
          backendId,
          policyRevision,
          locator,
        }), signal)
      } catch {
        return fail('BACKEND_RESOLVE_FAILED')
      }

      const secretCandidate = byteCandidate(raw, 'secret')
      const sourceSecret = plainBytes(secretCandidate) ? secretCandidate : null
      const result = exactData(raw, ['schemaVersion', 'status', 'locator', 'secret'])
      if (result === null || result['schemaVersion'] !== 1 || result['status'] !== 'resolved' ||
        !sameLocator(result['locator'], locator) || sourceSecret === null ||
        sourceSecret.byteLength < 1 || sourceSecret.byteLength > MAX_SECRET_BYTES) {
        zero(secretCandidate)
        return fail('BACKEND_RESPONSE_REJECTED')
      }

      const ownedSecret = new Uint8Array(sourceSecret)
      zero(sourceSecret)
      try {
        await consume(ownedSecret)
      } finally {
        zero(ownedSecret)
      }
    },
  })
}

export function makeIsolatedOpaqueByteTransport(input: Readonly<{
  transportId: string
  policyRevision: string
  process: OpaqueByteProxyProcessPort
}>): OpaqueCredentialByteTransportPort {
  const transportId = cleanIdentifier(input.transportId)
  const policyRevision = cleanIdentifier(input.policyRevision)
  const process = input.process

  return Object.freeze<OpaqueCredentialByteTransportPort>({
    async attest(signal) {
      let raw: unknown
      try {
        raw = await process.run(Object.freeze({
          operation: 'attest-transport',
          transportId,
          policyRevision,
        }), signal)
      } catch {
        return fail('TRANSPORT_ATTESTATION_FAILED')
      }
      return transportAttestation(raw, transportId, policyRevision)
    },

    async send(inputValue) {
      if (!IDENTIFIER.test(inputValue.requestId) ||
        !validDescriptor(inputValue.descriptor) || !plainBytes(inputValue.authorization) ||
        inputValue.authorization.byteLength < 1 ||
        inputValue.authorization.byteLength > MAX_SECRET_BYTES ||
        (inputValue.body !== null && !plainBytes(inputValue.body)) ||
        (inputValue.body?.byteLength ?? 0) > inputValue.descriptor.requestMaxBytes) {
        return fail('TRANSPORT_RESPONSE_REJECTED')
      }

      let raw: unknown
      try {
        raw = await process.run(Object.freeze({
          operation: 'exchange',
          requestId: inputValue.requestId,
          descriptor: inputValue.descriptor,
          authorization: inputValue.authorization,
          body: inputValue.body,
        }), inputValue.signal)
      } catch {
        return fail('TRANSPORT_EXCHANGE_FAILED')
      }

      const bodyCandidate = byteCandidate(raw, 'body')
      const body = plainBytes(bodyCandidate) ? bodyCandidate : null
      const result = exactData(raw, ['status', 'body'])
      const validBody = result?.['body'] === null || body !== null
      if (result === null || !Number.isInteger(result['status']) || Number(result['status']) < 100 ||
        Number(result['status']) > 599 || !validBody ||
        (body?.byteLength ?? 0) > inputValue.descriptor.responseMaxBytes ||
        (inputValue.descriptor.responseMode === 'status-only' && result['body'] !== null)) {
        zero(bodyCandidate)
        return fail('TRANSPORT_RESPONSE_REJECTED')
      }
      return Object.freeze({ status: Number(result['status']), body: null })
    },
  })
}

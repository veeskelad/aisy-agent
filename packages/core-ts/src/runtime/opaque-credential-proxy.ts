const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]*$/

const HANDLE_BRAND: unique symbol = Symbol('OpaqueSecretHandle')
const CAPABILITY_BRAND: unique symbol = Symbol('OpaqueSecretUseCapability')

export type OpaqueSecretHandle = string & { readonly [HANDLE_BRAND]: true }
export type OpaqueSecretProvider = 'openai' | 'anthropic' | 'openrouter'
export type OpaqueCredentialResponseMode = 'status-only'

export interface OpaqueCredentialLocatorV1 {
  schemaVersion: 1
  handle: OpaqueSecretHandle
  operatorId: string
  profileId: string
  connectionId: string
  connectionRevision: string
  provider: OpaqueSecretProvider
  providerSlot: string
  credentialRevision: number
  generation: number
  state: 'active'
}

export interface OpaqueCredentialDescriptorV1 {
  schemaVersion: 1
  descriptorId: string
  descriptorRevision: number
  clientId: string
  provider: OpaqueSecretProvider
  providerSlot: string
  origin: `https://${string}`
  method: 'GET' | 'POST'
  path: string
  authProtocol: 'bearer' | 'anthropic-x-api-key-2023-06-01'
  timeoutMs: number
  requestMaxBytes: number
  responseMaxBytes: number
  responseMode: 'status-only'
  redirects: 'deny'
}

export interface OpaqueCredentialClientPolicyV1 {
  schemaVersion: 1
  clientId: string
  operatorId: string
  profileId: string
  connectionId: string
  provider: OpaqueSecretProvider
  providerSlot: string
  descriptorIds: readonly string[]
}

interface OpaqueSecretUseCapability {
  readonly [CAPABILITY_BRAND]: true
  readonly capabilityId: string
  readonly requestId: string
  readonly bindingHash: string
  readonly descriptorId: string
  readonly descriptorRevision: number
  readonly expiresAtMs: number
}

export interface OpaqueCredentialBindingAuthorityAttestationV1 {
  schemaVersion: 1
  status: 'trusted'
  authorityId: string
  policyRevision: string
  capabilities: readonly ['exact-active-binding', 'revocation-generation-fence']
}

export interface OpaqueCredentialUseAuthorizationV1 {
  schemaVersion: 1
  status: 'authorized'
  authorityId: string
  requestId: string
  bindingHash: string
}

export interface OpaqueCredentialBindingAuthorityPort {
  attest(signal: AbortSignal): Promise<OpaqueCredentialBindingAuthorityAttestationV1>
  authorizeUse(input: Readonly<{
    requestId: string
    clientId: string
    locator: Readonly<OpaqueCredentialLocatorV1>
    descriptorId: string
    descriptorRevision: number
    expiresAtMs: number
    signal: AbortSignal
  }>): Promise<OpaqueCredentialUseAuthorizationV1>
}

export interface OpaqueSecretBackendAttestationV1 {
  schemaVersion: 1
  status: 'trusted'
  backendId: string
  policyRevision: string
  capabilities: readonly ['resolve-callback', 'exact-binding', 'confirmed-delete']
}

export interface OpaqueProxyTransportAttestationV1 {
  schemaVersion: 1
  status: 'trusted'
  transportId: string
  policyRevision: string
  byteOwnedAuthorization: true
  dnsPolicy: 'resolve-public-and-pin'
  tlsPolicy: 'exact-hostname-sni-system-ca-tls12'
  redirects: 'deny'
  proxyEnvironment: 'disabled'
  connectionReuse: 'disabled'
  bounds: 'request-response-decompressed-chunks'
}

export interface OpaqueSecretBackendPort {
  attest(signal: AbortSignal): Promise<OpaqueSecretBackendAttestationV1>
  withActiveSecret(
    locator: Readonly<OpaqueCredentialLocatorV1>,
    capability: OpaqueSecretUseCapability,
    consume: (ownedSecret: Uint8Array) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>
}

export interface OpaqueCredentialByteTransportResult {
  status: number
  body: null
}

export interface OpaqueCredentialByteTransportPort {
  attest(signal: AbortSignal): Promise<OpaqueProxyTransportAttestationV1>
  send(input: Readonly<{
    requestId: string
    descriptor: Readonly<OpaqueCredentialDescriptorV1>
    authorization: Uint8Array
    body: Uint8Array | null
    signal: AbortSignal
  }>): Promise<OpaqueCredentialByteTransportResult>
}

export type OpaqueCredentialProxyErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_READY'
  | 'AUTHORITY_UNATTESTED'
  | 'BACKEND_UNATTESTED'
  | 'TRANSPORT_UNATTESTED'
  | 'NOT_AVAILABLE'
  | 'BINDING_MISMATCH'
  | 'DESCRIPTOR_DENIED'
  | 'CAPABILITY_EXPIRED'
  | 'CAPABILITY_REPLAYED'
  | 'QUOTA_EXCEEDED'
  | 'BACKEND_FAILED'
  | 'TRANSPORT_FAILED'
  | 'RESPONSE_REJECTED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'STOPPED'

export class OpaqueCredentialProxyError extends Error {
  constructor(public readonly code: OpaqueCredentialProxyErrorCode) {
    super(code)
    this.name = 'OpaqueCredentialProxyError'
  }
}

export interface OpaqueCredentialProxyEventV1 {
  schemaVersion: 1
  eventId: string
  clientId: string
  provider: OpaqueSecretProvider
  descriptorId: string
  outcome: 'completed' | 'failed' | 'aborted'
  at: string
}

export interface OpaqueCredentialProxyRequestV1 {
  schemaVersion: 1
  handle: OpaqueSecretHandle
  connectionRevision: string
  credentialRevision: number
  generation: number
  descriptorId: string
  descriptorRevision: number
  body?: Uint8Array | null
  signal?: AbortSignal
}

export interface OpaqueCredentialProxyResponseV1 {
  status: number
  body: null
}

export interface OpaqueCredentialProxyClient {
  request(input: OpaqueCredentialProxyRequestV1): Promise<Readonly<OpaqueCredentialProxyResponseV1>>
}

export interface OpaqueCredentialProxy {
  start(signal?: AbortSignal): Promise<void>
  getClient(clientId: string): OpaqueCredentialProxyClient | null
  /** Local admission fence only. Durable revoke remains owned by the credential lifecycle authority. */
  fenceRevokedHandle(handle: OpaqueSecretHandle): Promise<void>
  stop(): Promise<void>
}

export interface OpaqueCredentialProxyQuotas {
  attestationTimeoutMs: number
  capabilityTtlMs: number
  maxInflightGlobal: number
  maxInflightPerHandle: number
  maxRequestsPerMinutePerHandle: number
  maxRequestBytes: number
  maxResponseBytes: number
}

export interface OpaqueCredentialProxyDeps {
  authorityId: string
  authorityPolicyRevision: string
  authority: OpaqueCredentialBindingAuthorityPort
  backendId: string
  backendPolicyRevision: string
  transportId: string
  transportPolicyRevision: string
  backend: OpaqueSecretBackendPort
  transport: OpaqueCredentialByteTransportPort
  descriptors: readonly OpaqueCredentialDescriptorV1[]
  clientPolicies: readonly OpaqueCredentialClientPolicyV1[]
  quotas: Readonly<OpaqueCredentialProxyQuotas>
  nowMs?: () => number
  newId?: () => string
  onEvent?: (event: Readonly<OpaqueCredentialProxyEventV1>) => void
}

interface Attempt {
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly ownedBuffers: Set<Uint8Array>
  readonly abortOwnedBuffers: () => void
  settle(): void
}

const PROVIDER_POLICY: Readonly<Record<OpaqueSecretProvider, Readonly<{
  slot: string
  origin: string
  authProtocol: OpaqueCredentialDescriptorV1['authProtocol']
}>>> = Object.freeze({
  openai: Object.freeze({ slot: 'openai-api-key', origin: 'https://api.openai.com', authProtocol: 'bearer' }),
  anthropic: Object.freeze({
    slot: 'anthropic-api-key',
    origin: 'https://api.anthropic.com',
    authProtocol: 'anthropic-x-api-key-2023-06-01',
  }),
  openrouter: Object.freeze({ slot: 'openrouter-api-key', origin: 'https://openrouter.ai', authProtocol: 'bearer' }),
})

function fail(code: OpaqueCredentialProxyErrorCode): never {
  throw new OpaqueCredentialProxyError(code)
}

function exactObject(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('INVALID_INPUT')
    const actual = Reflect.ownKeys(value)
    if (actual.length !== keys.size || actual.some(key => typeof key !== 'string' || !keys.has(key))) {
      return fail('INVALID_INPUT')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return fail('INVALID_INPUT')
      copy[key] = descriptor.value
    }
    return copy
  } catch (error) {
    if (error instanceof OpaqueCredentialProxyError) throw error
    return fail('INVALID_INPUT')
  }
}

function exactArray(value: unknown, expected: readonly string[]): boolean {
  try {
    if (!Array.isArray(value) || value.length !== expected.length) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expected.length + 1 || keys.at(-1) !== 'length') return false
    return expected.every((item, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      return descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.value === item
    })
  } catch {
    return false
  }
}

function cleanId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) return fail('INVALID_INPUT')
  return value
}

function cleanPositive(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) return fail('INVALID_INPUT')
  return Number(value)
}

function cleanProvider(value: unknown): OpaqueSecretProvider {
  if (value !== 'openai' && value !== 'anthropic' && value !== 'openrouter') return fail('INVALID_INPUT')
  return value
}

function validateQuotas(value: OpaqueCredentialProxyQuotas): Readonly<OpaqueCredentialProxyQuotas> {
  return Object.freeze({
    attestationTimeoutMs: cleanPositive(value.attestationTimeoutMs, 60_000),
    capabilityTtlMs: cleanPositive(value.capabilityTtlMs, 60_000),
    maxInflightGlobal: cleanPositive(value.maxInflightGlobal, 1_000),
    maxInflightPerHandle: cleanPositive(value.maxInflightPerHandle, 100),
    maxRequestsPerMinutePerHandle: cleanPositive(value.maxRequestsPerMinutePerHandle, 10_000),
    maxRequestBytes: cleanPositive(value.maxRequestBytes, 16 * 1024 * 1024),
    maxResponseBytes: cleanPositive(value.maxResponseBytes, 16 * 1024 * 1024),
  })
}

function copyDescriptor(value: unknown, quotas: OpaqueCredentialProxyQuotas): Readonly<OpaqueCredentialDescriptorV1> {
  const raw = exactObject(value, new Set([
    'schemaVersion', 'descriptorId', 'descriptorRevision', 'clientId', 'provider', 'providerSlot',
    'origin', 'method', 'path', 'authProtocol', 'timeoutMs', 'requestMaxBytes', 'responseMaxBytes',
    'responseMode', 'redirects',
  ]))
  const provider = cleanProvider(raw['provider'])
  const policy = PROVIDER_POLICY[provider]
  if ((raw['method'] !== 'GET' && raw['method'] !== 'POST') || raw['schemaVersion'] !== 1 ||
    raw['responseMode'] !== 'status-only' || raw['redirects'] !== 'deny' ||
    raw['providerSlot'] !== policy.slot || raw['origin'] !== policy.origin ||
    raw['authProtocol'] !== policy.authProtocol || typeof raw['path'] !== 'string' ||
    !PATH.test(raw['path']) || raw['path'].includes('//')) return fail('INVALID_INPUT')
  return Object.freeze({
    schemaVersion: 1,
    descriptorId: cleanId(raw['descriptorId']),
    descriptorRevision: cleanPositive(raw['descriptorRevision']),
    clientId: cleanId(raw['clientId']),
    provider,
    providerSlot: policy.slot,
    origin: policy.origin as `https://${string}`,
    method: raw['method'],
    path: raw['path'],
    authProtocol: policy.authProtocol,
    timeoutMs: cleanPositive(raw['timeoutMs'], 120_000),
    requestMaxBytes: cleanPositive(raw['requestMaxBytes'], quotas.maxRequestBytes),
    responseMaxBytes: cleanPositive(raw['responseMaxBytes'], quotas.maxResponseBytes),
    responseMode: 'status-only',
    redirects: 'deny',
  })
}

function copyClientPolicy(value: unknown): Readonly<OpaqueCredentialClientPolicyV1> {
  const raw = exactObject(value, new Set([
    'schemaVersion', 'clientId', 'operatorId', 'profileId', 'connectionId', 'provider',
    'providerSlot', 'descriptorIds',
  ]))
  const provider = cleanProvider(raw['provider'])
  if (raw['schemaVersion'] !== 1 || raw['providerSlot'] !== PROVIDER_POLICY[provider].slot ||
    !Array.isArray(raw['descriptorIds']) || raw['descriptorIds'].length === 0 ||
    Reflect.ownKeys(raw['descriptorIds']).length !== raw['descriptorIds'].length + 1) {
    return fail('INVALID_INPUT')
  }
  const descriptorIds = raw['descriptorIds'].map(item => cleanId(item))
  if (new Set(descriptorIds).size !== descriptorIds.length) return fail('INVALID_INPUT')
  return Object.freeze({
    schemaVersion: 1,
    clientId: cleanId(raw['clientId']),
    operatorId: cleanId(raw['operatorId']),
    profileId: cleanId(raw['profileId']),
    connectionId: cleanId(raw['connectionId']),
    provider,
    providerSlot: PROVIDER_POLICY[provider].slot,
    descriptorIds: Object.freeze(descriptorIds),
  })
}

function copyRequest(value: unknown, maxBytes: number): Readonly<{
  handle: OpaqueSecretHandle
  connectionRevision: string
  credentialRevision: number
  generation: number
  descriptorId: string
  descriptorRevision: number
  body: Uint8Array | null
  signal: AbortSignal | undefined
}> {
  let hasBody = false
  let hasSignal = false
  try {
    hasBody = typeof value === 'object' && value !== null && Object.hasOwn(value, 'body')
    hasSignal = typeof value === 'object' && value !== null && Object.hasOwn(value, 'signal')
  } catch {
    return fail('INVALID_INPUT')
  }
  const keys = new Set([
    'schemaVersion', 'handle', 'connectionRevision', 'credentialRevision', 'generation',
    'descriptorId', 'descriptorRevision', ...(hasBody ? ['body'] : []), ...(hasSignal ? ['signal'] : []),
  ])
  const raw = exactObject(value, keys)
  const handle = cleanId(raw['handle'])
  if (raw['schemaVersion'] !== 1 || !HANDLE.test(handle)) return fail('INVALID_INPUT')
  const rawBody = hasBody ? raw['body'] : null
  if (rawBody !== null && !(rawBody instanceof Uint8Array)) return fail('INVALID_INPUT')
  if ((rawBody?.byteLength ?? 0) > maxBytes) return fail('INVALID_INPUT')
  const rawSignal = hasSignal ? raw['signal'] : undefined
  if (rawSignal !== undefined && !(rawSignal instanceof AbortSignal)) return fail('INVALID_INPUT')
  return Object.freeze({
    handle: handle as OpaqueSecretHandle,
    connectionRevision: cleanId(raw['connectionRevision']),
    credentialRevision: cleanPositive(raw['credentialRevision']),
    generation: cleanPositive(raw['generation']),
    descriptorId: cleanId(raw['descriptorId']),
    descriptorRevision: cleanPositive(raw['descriptorRevision']),
    body: rawBody === null ? null : new Uint8Array(rawBody),
    signal: rawSignal,
  })
}

function zero(value: Uint8Array | null | undefined): void {
  if (value !== null && value !== undefined) value.fill(0)
}

function linkAbort(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (parent === undefined) return () => undefined
  const abort = () => controller.abort()
  if (parent.aborted) abort()
  else parent.addEventListener('abort', abort, { once: true })
  return () => parent.removeEventListener('abort', abort)
}

function deadline<T>(operation: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  if (controller.signal.aborted) return Promise.reject(new OpaqueCredentialProxyError('ABORTED'))
  return new Promise<T>((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new OpaqueCredentialProxyError('TIMEOUT'))
    }, timeoutMs)
    const onAbort = () => reject(new OpaqueCredentialProxyError(timedOut ? 'TIMEOUT' : 'ABORTED'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
    operation.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
    }).catch(() => undefined)
  })
}

function stable<T>(work: () => T, code: OpaqueCredentialProxyErrorCode): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof OpaqueCredentialProxyError && error.code !== 'INVALID_INPUT') throw error
    return fail(code)
  }
}

function validateAuthorityAttestation(value: unknown, authorityId: string, revision: string): void {
  stable(() => {
    const raw = exactObject(value, new Set(['schemaVersion', 'status', 'authorityId', 'policyRevision', 'capabilities']))
    if (raw['schemaVersion'] !== 1 || raw['status'] !== 'trusted' || raw['authorityId'] !== authorityId ||
      raw['policyRevision'] !== revision ||
      !exactArray(raw['capabilities'], ['exact-active-binding', 'revocation-generation-fence'])) {
      return fail('AUTHORITY_UNATTESTED')
    }
  }, 'AUTHORITY_UNATTESTED')
}

function validateBackendAttestation(value: unknown, backendId: string, revision: string): void {
  stable(() => {
    const raw = exactObject(value, new Set(['schemaVersion', 'status', 'backendId', 'policyRevision', 'capabilities']))
    if (raw['schemaVersion'] !== 1 || raw['status'] !== 'trusted' || raw['backendId'] !== backendId ||
      raw['policyRevision'] !== revision ||
      !exactArray(raw['capabilities'], ['resolve-callback', 'exact-binding', 'confirmed-delete'])) {
      return fail('BACKEND_UNATTESTED')
    }
  }, 'BACKEND_UNATTESTED')
}

function validateTransportAttestation(value: unknown, transportId: string, revision: string): void {
  stable(() => {
    const raw = exactObject(value, new Set([
      'schemaVersion', 'status', 'transportId', 'policyRevision', 'byteOwnedAuthorization', 'dnsPolicy',
      'tlsPolicy', 'redirects', 'proxyEnvironment', 'connectionReuse', 'bounds',
    ]))
    if (raw['schemaVersion'] !== 1 || raw['status'] !== 'trusted' || raw['transportId'] !== transportId ||
      raw['policyRevision'] !== revision || raw['byteOwnedAuthorization'] !== true ||
      raw['dnsPolicy'] !== 'resolve-public-and-pin' ||
      raw['tlsPolicy'] !== 'exact-hostname-sni-system-ca-tls12' || raw['redirects'] !== 'deny' ||
      raw['proxyEnvironment'] !== 'disabled' || raw['connectionReuse'] !== 'disabled' ||
      raw['bounds'] !== 'request-response-decompressed-chunks') return fail('TRANSPORT_UNATTESTED')
  }, 'TRANSPORT_UNATTESTED')
}

function validateAuthorization(
  value: unknown,
  authorityId: string,
  requestId: string,
): string {
  return stable(() => {
    const raw = exactObject(value, new Set(['schemaVersion', 'status', 'authorityId', 'requestId', 'bindingHash']))
    if (raw['schemaVersion'] !== 1 || raw['status'] !== 'authorized' || raw['authorityId'] !== authorityId ||
      raw['requestId'] !== requestId || typeof raw['bindingHash'] !== 'string' || !HASH.test(raw['bindingHash'])) {
      return fail('NOT_AVAILABLE')
    }
    return raw['bindingHash']
  }, 'NOT_AVAILABLE')
}

function validateTransportResult(value: unknown): OpaqueCredentialByteTransportResult {
  return stable(() => {
    const raw = exactObject(value, new Set(['status', 'body']))
    if (!Number.isInteger(raw['status']) || Number(raw['status']) < 100 || Number(raw['status']) > 599 ||
      raw['body'] !== null) return fail('RESPONSE_REJECTED')
    return { status: Number(raw['status']), body: null }
  }, 'RESPONSE_REJECTED')
}

export function makeOpaqueCredentialProxy(deps: OpaqueCredentialProxyDeps): OpaqueCredentialProxy {
  const quotas = validateQuotas(deps.quotas)
  const nowPort = deps.nowMs ?? Date.now
  let fallbackId = 0
  const idPort = deps.newId ?? (() => `opaque-${++fallbackId}`)
  const onEvent = deps.onEvent
  const authorityId = cleanId(deps.authorityId)
  const authorityPolicyRevision = cleanId(deps.authorityPolicyRevision)
  const backendId = cleanId(deps.backendId)
  const backendPolicyRevision = cleanId(deps.backendPolicyRevision)
  const transportId = cleanId(deps.transportId)
  const transportPolicyRevision = cleanId(deps.transportPolicyRevision)
  const authorityAttest = deps.authority.attest.bind(deps.authority)
  const authorizeUse = deps.authority.authorizeUse.bind(deps.authority)
  const backendAttest = deps.backend.attest.bind(deps.backend)
  const withActiveSecret = deps.backend.withActiveSecret.bind(deps.backend)
  const transportAttest = deps.transport.attest.bind(deps.transport)
  const transportSend = deps.transport.send.bind(deps.transport)

  const descriptors = new Map<string, Readonly<OpaqueCredentialDescriptorV1>>()
  const policies = new Map<string, Readonly<OpaqueCredentialClientPolicyV1>>()
  const clients = new Map<string, OpaqueCredentialProxyClient>()
  const attempts = new Map<string, Set<Attempt>>()
  const requestTimes = new Map<string, number[]>()
  const capabilities = new WeakMap<object, { used: boolean; expiresAtMs: number }>()
  const fenced = new Set<string>()
  const issuedIds = new Set<string>()
  let lastNowMs: number | null = null
  let inflightGlobal = 0
  let ready = false
  let stopped = false
  let startPass: Readonly<{ controller: AbortController; publicPromise: Promise<void>; settled: Promise<void> }> | null = null

  function clock(): number {
    let value: number
    try {
      value = nowPort()
    } catch {
      return fail('INVALID_INPUT')
    }
    if (!Number.isSafeInteger(value) || value < 0 || (lastNowMs !== null && value < lastNowMs)) {
      return fail('INVALID_INPUT')
    }
    lastNowMs = value
    return value
  }

  function uniqueId(): string {
    let value: string
    try {
      value = cleanId(idPort())
    } catch {
      return fail('INVALID_INPUT')
    }
    if (issuedIds.has(value)) return fail('INVALID_INPUT')
    issuedIds.add(value)
    return value
  }

  clock()
  for (const value of deps.descriptors) {
    const descriptor = copyDescriptor(value, quotas)
    if (descriptors.has(descriptor.descriptorId)) fail('INVALID_INPUT')
    descriptors.set(descriptor.descriptorId, descriptor)
  }
  for (const value of deps.clientPolicies) {
    const policy = copyClientPolicy(value)
    if (policies.has(policy.clientId)) fail('INVALID_INPUT')
    for (const descriptorId of policy.descriptorIds) {
      const descriptor = descriptors.get(descriptorId)
      if (descriptor === undefined || descriptor.clientId !== policy.clientId ||
        descriptor.provider !== policy.provider || descriptor.providerSlot !== policy.providerSlot) {
        fail('INVALID_INPUT')
      }
    }
    policies.set(policy.clientId, policy)
  }
  if ([...descriptors.values()].some(descriptor => !policies.has(descriptor.clientId))) fail('INVALID_INPUT')

  function emit(policy: Readonly<OpaqueCredentialClientPolicyV1>, descriptorId: string,
    outcome: OpaqueCredentialProxyEventV1['outcome']): void {
    if (onEvent === undefined) return
    try {
      onEvent(Object.freeze({
        schemaVersion: 1,
        eventId: uniqueId(),
        clientId: policy.clientId,
        provider: policy.provider,
        descriptorId,
        outcome,
        at: new Date(clock()).toISOString(),
      }))
    } catch {
      // Non-authoritative observability cannot affect the credential boundary.
    }
  }

  function registerAttempt(handle: string, controller: AbortController): Attempt {
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    const ownedBuffers = new Set<Uint8Array>()
    const abortOwnedBuffers = () => {
      for (const buffer of ownedBuffers) zero(buffer)
    }
    controller.signal.addEventListener('abort', abortOwnedBuffers, { once: true })
    const attempt: Attempt = { controller, settled, ownedBuffers, abortOwnedBuffers, settle }
    const group = attempts.get(handle) ?? new Set<Attempt>()
    group.add(attempt)
    attempts.set(handle, group)
    return attempt
  }

  function finishAttempt(handle: string, attempt: Attempt): void {
    const group = attempts.get(handle)
    group?.delete(attempt)
    if (group?.size === 0) attempts.delete(handle)
    attempt.controller.signal.removeEventListener('abort', attempt.abortOwnedBuffers)
    attempt.settle()
  }

  function reserve(handle: string): number {
    if (fenced.has(handle)) return fail('NOT_AVAILABLE')
    if (inflightGlobal >= quotas.maxInflightGlobal ||
      (attempts.get(handle)?.size ?? 0) >= quotas.maxInflightPerHandle) return fail('QUOTA_EXCEEDED')
    const now = clock()
    const recent = (requestTimes.get(handle) ?? []).filter(item => item > now - 60_000)
    if (recent.length >= quotas.maxRequestsPerMinutePerHandle) return fail('QUOTA_EXCEEDED')
    recent.push(now)
    requestTimes.set(handle, recent)
    return now
  }

  async function request(policy: Readonly<OpaqueCredentialClientPolicyV1>, inputValue: unknown):
  Promise<Readonly<OpaqueCredentialProxyResponseV1>> {
    if (stopped) return fail('STOPPED')
    if (!ready) return fail('NOT_READY')
    const requestInput = copyRequest(inputValue, quotas.maxRequestBytes)
    const descriptor = descriptors.get(requestInput.descriptorId)
    if (descriptor === undefined || !policy.descriptorIds.includes(descriptor.descriptorId) ||
      descriptor.descriptorRevision !== requestInput.descriptorRevision) {
      zero(requestInput.body)
      return fail('DESCRIPTOR_DENIED')
    }
    if (requestInput.body !== null && descriptor.method === 'GET') {
      zero(requestInput.body)
      return fail('INVALID_INPUT')
    }
    if ((requestInput.body?.byteLength ?? 0) > descriptor.requestMaxBytes) {
      zero(requestInput.body)
      return fail('INVALID_INPUT')
    }
    if (requestInput.signal?.aborted === true) {
      zero(requestInput.body)
      return fail('ABORTED')
    }
    let admittedAt: number
    let requestId: string
    let capabilityId: string
    try {
      admittedAt = reserve(requestInput.handle)
      requestId = uniqueId()
      capabilityId = uniqueId()
    } catch (error) {
      zero(requestInput.body)
      throw error
    }
    const expiresAtMs = admittedAt + quotas.capabilityTtlMs
    const locator: Readonly<OpaqueCredentialLocatorV1> = Object.freeze({
      schemaVersion: 1,
      handle: requestInput.handle,
      operatorId: policy.operatorId,
      profileId: policy.profileId,
      connectionId: policy.connectionId,
      connectionRevision: requestInput.connectionRevision,
      provider: policy.provider,
      providerSlot: policy.providerSlot,
      credentialRevision: requestInput.credentialRevision,
      generation: requestInput.generation,
      state: 'active',
    })
    const controller = new AbortController()
    const unlink = linkAbort(requestInput.signal, controller)
    const attempt = registerAttempt(requestInput.handle, controller)
    if (requestInput.body !== null) attempt.ownedBuffers.add(requestInput.body)
    inflightGlobal += 1

    const operation = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted || fenced.has(requestInput.handle) || stopped) return fail('ABORTED')
        let authorization: OpaqueCredentialUseAuthorizationV1
        try {
          authorization = await authorizeUse(Object.freeze({
            requestId,
            clientId: policy.clientId,
            locator,
            descriptorId: descriptor.descriptorId,
            descriptorRevision: descriptor.descriptorRevision,
            expiresAtMs,
            signal: controller.signal,
          }))
        } catch (error) {
          if (error instanceof OpaqueCredentialProxyError) throw error
          return fail(controller.signal.aborted ? 'ABORTED' : 'NOT_AVAILABLE')
        }
        const bindingHash = validateAuthorization(authorization, authorityId, requestId)
        if (controller.signal.aborted || fenced.has(requestInput.handle) || stopped) return fail('ABORTED')
        const capability = Object.freeze({
          [CAPABILITY_BRAND]: true as const,
          capabilityId,
          requestId,
          bindingHash,
          descriptorId: descriptor.descriptorId,
          descriptorRevision: descriptor.descriptorRevision,
          expiresAtMs,
        })
        capabilities.set(capability, { used: false, expiresAtMs })
        const consumeTasks: Promise<void>[] = []
        let response: Readonly<OpaqueCredentialProxyResponseV1> | null = null

        const consume = (ownedSecret: Uint8Array): Promise<void> => {
          const task = Promise.resolve().then(async () => {
            if (!(ownedSecret instanceof Uint8Array)) return fail('BACKEND_FAILED')
            attempt.ownedBuffers.add(ownedSecret)
            try {
              const capabilityState = capabilities.get(capability)
              if (capabilityState === undefined || capabilityState.used) return fail('CAPABILITY_REPLAYED')
              capabilityState.used = true
              if (clock() >= capabilityState.expiresAtMs) return fail('CAPABILITY_EXPIRED')
              if (controller.signal.aborted || fenced.has(requestInput.handle) || stopped) return fail('ABORTED')
              if (ownedSecret.byteLength === 0) return fail('BACKEND_FAILED')
              let transportResult: OpaqueCredentialByteTransportResult
              try {
                transportResult = validateTransportResult(await transportSend(Object.freeze({
                  requestId,
                  descriptor,
                  authorization: ownedSecret,
                  body: requestInput.body,
                  signal: controller.signal,
                })))
              } catch (error) {
                if (error instanceof OpaqueCredentialProxyError) throw error
                return fail(controller.signal.aborted ? 'ABORTED' : 'TRANSPORT_FAILED')
              }
              if (controller.signal.aborted || fenced.has(requestInput.handle) || stopped) return fail('ABORTED')
              response = Object.freeze({ status: transportResult.status, body: null })
            } finally {
              zero(ownedSecret)
              attempt.ownedBuffers.delete(ownedSecret)
            }
          })
          consumeTasks.push(task)
          void task.catch(() => undefined)
          return task
        }

        let backendFailure: unknown = null
        try {
          await withActiveSecret(locator, capability, consume, controller.signal)
        } catch (error) {
          backendFailure = error
        }
        const consumed = await Promise.allSettled(consumeTasks)
        capabilities.delete(capability)
        const rejected = consumed.find(result => result.status === 'rejected')
        if (rejected?.status === 'rejected') throw rejected.reason
        if (backendFailure !== null) {
          if (backendFailure instanceof OpaqueCredentialProxyError) throw backendFailure
          return fail(controller.signal.aborted ? 'ABORTED' : 'BACKEND_FAILED')
        }
        if (consumeTasks.length !== 1 || response === null) return fail('BACKEND_FAILED')
        return response
      } finally {
        zero(requestInput.body)
        if (requestInput.body !== null) attempt.ownedBuffers.delete(requestInput.body)
      }
    })
    operation.finally(() => {
      inflightGlobal -= 1
      finishAttempt(requestInput.handle, attempt)
    }).catch(() => undefined)

    try {
      const result = await deadline(operation, descriptor.timeoutMs, controller)
      if (controller.signal.aborted || fenced.has(requestInput.handle) || stopped) {
        return fail(stopped ? 'STOPPED' : 'ABORTED')
      }
      emit(policy, descriptor.descriptorId, 'completed')
      return result
    } catch (error) {
      const stableError = error instanceof OpaqueCredentialProxyError
        ? error
        : new OpaqueCredentialProxyError(controller.signal.aborted ? 'ABORTED' : 'BACKEND_FAILED')
      emit(policy, descriptor.descriptorId,
        stableError.code === 'ABORTED' || stableError.code === 'STOPPED' ? 'aborted' : 'failed')
      throw stableError
    } finally {
      unlink()
    }
  }

  for (const policy of policies.values()) {
    clients.set(policy.clientId, Object.freeze({
      request: (input: OpaqueCredentialProxyRequestV1) => request(policy, input),
    }))
  }

  function start(signal?: AbortSignal): Promise<void> {
    if (stopped) return Promise.reject(new OpaqueCredentialProxyError('STOPPED'))
    if (ready) return Promise.resolve()
    if (startPass !== null) return startPass.publicPromise
    const controller = new AbortController()
    const unlink = linkAbort(signal, controller)
    const operation = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return fail('ABORTED')
      const authority = await authorityAttest(controller.signal).catch(() => fail(
        controller.signal.aborted ? 'ABORTED' : 'AUTHORITY_UNATTESTED'))
      validateAuthorityAttestation(authority, authorityId, authorityPolicyRevision)
      const backend = await backendAttest(controller.signal).catch(() => fail(
        controller.signal.aborted ? 'ABORTED' : 'BACKEND_UNATTESTED'))
      validateBackendAttestation(backend, backendId, backendPolicyRevision)
      const transport = await transportAttest(controller.signal).catch(() => fail(
        controller.signal.aborted ? 'ABORTED' : 'TRANSPORT_UNATTESTED'))
      validateTransportAttestation(transport, transportId, transportPolicyRevision)
      if (controller.signal.aborted || stopped) return fail('ABORTED')
      ready = true
    })
    const publicPromise = deadline(operation, quotas.attestationTimeoutMs, controller).finally(unlink)
    const settled = operation.then(() => undefined, () => undefined).finally(() => {
      if (startPass?.settled === settled) startPass = null
    })
    startPass = Object.freeze({ controller, publicPromise, settled })
    return publicPromise
  }

  return Object.freeze({
    start,
    getClient(clientIdValue: string): OpaqueCredentialProxyClient | null {
      const clientId = cleanId(clientIdValue)
      return clients.get(clientId) ?? null
    },
    async fenceRevokedHandle(handleValue: OpaqueSecretHandle): Promise<void> {
      const handle = cleanId(handleValue)
      if (!HANDLE.test(handle)) return fail('INVALID_INPUT')
      fenced.add(handle)
      const group = attempts.get(handle)
      if (group === undefined) return
      for (const attempt of group) attempt.controller.abort()
      await Promise.all([...group].map(attempt => attempt.settled))
    },
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      startPass?.controller.abort()
      const pending: Promise<void>[] = startPass === null ? [] : [startPass.settled]
      for (const group of attempts.values()) {
        for (const attempt of group) {
          attempt.controller.abort()
          pending.push(attempt.settled)
        }
      }
      await Promise.all(pending)
      ready = false
    },
  })
}

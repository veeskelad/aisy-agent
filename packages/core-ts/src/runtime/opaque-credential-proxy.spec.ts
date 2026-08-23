import { describe, expect, it, vi } from 'vitest'

import {
  makeOpaqueCredentialProxy,
  OpaqueCredentialProxyError,
  type OpaqueCredentialBindingAuthorityPort,
  type OpaqueCredentialByteTransportPort,
  type OpaqueCredentialDescriptorV1,
  type OpaqueCredentialLocatorV1,
  type OpaqueCredentialProxyDeps,
  type OpaqueCredentialProxyRequestV1,
  type OpaqueSecretBackendPort,
  type OpaqueSecretHandle,
} from './opaque-credential-proxy.js'

const SENTINEL = 'aisy_synthetic_7Lz9Qp3Nx8_secret'
const HANDLE = 'opaque-handle-00000001' as OpaqueSecretHandle
const HASH = 'a'.repeat(64)

const LOCATOR: OpaqueCredentialLocatorV1 = Object.freeze({
  schemaVersion: 1,
  handle: HANDLE,
  operatorId: 'operator-1',
  profileId: 'profile-1',
  connectionId: 'connection-1',
  connectionRevision: 'connection-revision-1',
  provider: 'openai',
  providerSlot: 'openai-api-key',
  credentialRevision: 3,
  generation: 5,
  state: 'active',
})

const REQUEST: OpaqueCredentialProxyRequestV1 = Object.freeze({
  schemaVersion: 1,
  handle: HANDLE,
  connectionRevision: 'connection-revision-1',
  credentialRevision: 3,
  generation: 5,
  descriptorId: 'openai-models-v1',
  descriptorRevision: 1,
})

const DESCRIPTOR: OpaqueCredentialDescriptorV1 = Object.freeze({
  schemaVersion: 1,
  descriptorId: 'openai-models-v1',
  descriptorRevision: 1,
  clientId: 'openai-validator',
  provider: 'openai',
  providerSlot: 'openai-api-key',
  origin: 'https://api.openai.com',
  method: 'GET',
  path: '/v1/models',
  authProtocol: 'bearer',
  timeoutMs: 500,
  requestMaxBytes: 1024,
  responseMaxBytes: 1024,
  responseMode: 'status-only',
  redirects: 'deny',
})

function sameLocator(value: Readonly<OpaqueCredentialLocatorV1>): boolean {
  return Object.keys(LOCATOR).every(key =>
    value[key as keyof OpaqueCredentialLocatorV1] === LOCATOR[key as keyof OpaqueCredentialLocatorV1])
}

function harness(input: {
  authorityAttestation?: unknown
  backendAttestation?: unknown
  transportAttestation?: unknown
  authorize?: OpaqueCredentialBindingAuthorityPort['authorizeUse']
  backend?: OpaqueSecretBackendPort['withActiveSecret']
  send?: OpaqueCredentialByteTransportPort['send']
  descriptor?: OpaqueCredentialDescriptorV1
  maxRequests?: number
  maxInflight?: number
  nowMs?: () => number
  newId?: () => string
} = {}) {
  const secretBuffers: Uint8Array[] = []
  const authorizationBuffers: Uint8Array[] = []
  const events: unknown[] = []
  let id = 0
  const authorize: OpaqueCredentialBindingAuthorityPort['authorizeUse'] = input.authorize ?? (async value => {
    if (!sameLocator(value.locator) || value.clientId !== 'openai-validator' ||
      value.descriptorId !== 'openai-models-v1' || value.descriptorRevision !== 1) {
      throw new Error(`wrong authority binding ${SENTINEL}`)
    }
    return {
      schemaVersion: 1,
      status: 'authorized',
      authorityId: 'credential-authority-1',
      requestId: value.requestId,
      bindingHash: HASH,
    }
  })
  const authority: OpaqueCredentialBindingAuthorityPort = {
    attest: vi.fn(async () => input.authorityAttestation ?? ({
      schemaVersion: 1,
      status: 'trusted',
      authorityId: 'credential-authority-1',
      policyRevision: 'authority-policy-1',
      capabilities: ['exact-active-binding', 'revocation-generation-fence'],
    })) as never,
    authorizeUse: vi.fn(authorize) as OpaqueCredentialBindingAuthorityPort['authorizeUse'],
  }
  const resolveSecret: OpaqueSecretBackendPort['withActiveSecret'] = input.backend ??
    (async (_locator, _capability, consume) => {
      const owned = new TextEncoder().encode(SENTINEL)
      secretBuffers.push(owned)
      await consume(owned)
    })
  const backend: OpaqueSecretBackendPort = {
    attest: vi.fn(async () => input.backendAttestation ?? ({
      schemaVersion: 1,
      status: 'trusted',
      backendId: 'macos-keychain',
      policyRevision: 'backend-policy-1',
      capabilities: ['resolve-callback', 'exact-binding', 'confirmed-delete'],
    })) as never,
    withActiveSecret: vi.fn(resolveSecret) as OpaqueSecretBackendPort['withActiveSecret'],
  }
  const transport: OpaqueCredentialByteTransportPort = {
    attest: vi.fn(async () => input.transportAttestation ?? ({
      schemaVersion: 1,
      status: 'trusted',
      transportId: 'isolated-byte-proxy',
      policyRevision: 'transport-policy-1',
      byteOwnedAuthorization: true,
      dnsPolicy: 'resolve-public-and-pin',
      tlsPolicy: 'exact-hostname-sni-system-ca-tls12',
      redirects: 'deny',
      proxyEnvironment: 'disabled',
      connectionReuse: 'disabled',
      bounds: 'request-response-decompressed-chunks',
    })) as never,
    send: vi.fn(input.send ?? (async value => {
      authorizationBuffers.push(value.authorization)
      expect(new TextDecoder().decode(value.authorization)).toBe(SENTINEL)
      return { status: 200, body: null }
    })),
  }
  const deps: OpaqueCredentialProxyDeps = {
    authorityId: 'credential-authority-1',
    authorityPolicyRevision: 'authority-policy-1',
    authority,
    backendId: 'macos-keychain',
    backendPolicyRevision: 'backend-policy-1',
    transportId: 'isolated-byte-proxy',
    transportPolicyRevision: 'transport-policy-1',
    backend,
    transport,
    descriptors: [input.descriptor ?? DESCRIPTOR],
    clientPolicies: [{
      schemaVersion: 1,
      clientId: 'openai-validator',
      operatorId: 'operator-1',
      profileId: 'profile-1',
      connectionId: 'connection-1',
      provider: 'openai',
      providerSlot: 'openai-api-key',
      descriptorIds: ['openai-models-v1'],
    }],
    quotas: {
      attestationTimeoutMs: 100,
      capabilityTtlMs: 10,
      maxInflightGlobal: 2,
      maxInflightPerHandle: input.maxInflight ?? 1,
      maxRequestsPerMinutePerHandle: input.maxRequests ?? 10,
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
    },
    nowMs: input.nowMs ?? (() => 100),
    newId: input.newId ?? (() => `opaque-id-${++id}`),
    onEvent: event => events.push(event),
  }
  const proxy = makeOpaqueCredentialProxy(deps)
  const client = proxy.getClient('openai-validator')
  if (client === null) throw new Error('test client unavailable')
  return { proxy, client, deps, authority, backend, transport, secretBuffers, authorizationBuffers, events }
}

describe('opaque credential proxy', () => {
  it('requires three exact attestations, authoritative binding, and proxy-only byte injection', async () => {
    const target = harness()
    await target.proxy.start()
    await expect(target.client.request(REQUEST)).resolves.toEqual({ status: 200, body: null })
    expect(target.authority.authorizeUse).toHaveBeenCalledOnce()
    expect(target.backend.withActiveSecret).toHaveBeenCalledOnce()
    expect(target.transport.send).toHaveBeenCalledOnce()
    expect(target.authorizationBuffers[0]).toBe(target.secretBuffers[0])
    expect(target.secretBuffers[0]!.every(byte => byte === 0)).toBe(true)
    const publicSurface = JSON.stringify(target.events)
    expect(publicSurface).not.toContain(SENTINEL)
    expect(publicSurface).not.toContain(HANDLE)
  })

  it('fails closed on each malformed attestation before authority or secret use', async () => {
    const cases = [
      harness({ authorityAttestation: { status: 'trusted' } }),
      harness({ backendAttestation: { status: 'trusted' } }),
      harness({ transportAttestation: { status: 'trusted' } }),
    ]
    const codes = ['AUTHORITY_UNATTESTED', 'BACKEND_UNATTESTED', 'TRANSPORT_UNATTESTED']
    for (let index = 0; index < cases.length; index += 1) {
      await expect(cases[index]!.proxy.start()).rejects.toMatchObject({ code: codes[index] })
      expect(cases[index]!.authority.authorizeUse).not.toHaveBeenCalled()
      expect(cases[index]!.backend.withActiveSecret).not.toHaveBeenCalled()
    }
  })

  it('snapshots exact port methods and is immune to mutation after attestation', async () => {
    const target = harness()
    await target.proxy.start()
    target.deps.authority.authorizeUse = vi.fn(async () => { throw new Error(SENTINEL) })
    target.deps.backend.withActiveSecret = vi.fn(async () => { throw new Error(SENTINEL) })
    target.deps.transport.send = vi.fn(async () => { throw new Error(SENTINEL) })
    await expect(target.client.request(REQUEST)).resolves.toEqual({ status: 200, body: null })
  })

  it('never lets backend return values substitute for the proxy callback result', async () => {
    const omitted = harness({
      backend: async () => undefined,
    })
    await omitted.proxy.start()
    await expect(omitted.client.request(REQUEST)).rejects.toMatchObject({ code: 'BACKEND_FAILED' })
    expect(omitted.transport.send).not.toHaveBeenCalled()

    const forged = new TextEncoder().encode(SENTINEL)
    const substituted = harness({
      backend: async () => ({ status: 200, body: forged }) as never,
    })
    await substituted.proxy.start()
    const failure = await substituted.client.request(REQUEST).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'BACKEND_FAILED' })
    expect(String(failure)).not.toContain(SENTINEL)
    expect(substituted.transport.send).not.toHaveBeenCalled()
  })

  it('binds caller input to code-owned client identity before backend reveal', async () => {
    const mutations: Array<Partial<OpaqueCredentialProxyRequestV1>> = [
      { handle: 'opaque-handle-00000002' as OpaqueSecretHandle },
      { connectionRevision: 'connection-revision-2' },
      { credentialRevision: 4 },
      { generation: 6 },
    ]
    for (const mutation of mutations) {
      const target = harness()
      await target.proxy.start()
      const failure = await target.client.request({ ...REQUEST, ...mutation }).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'NOT_AVAILABLE' })
      expect(String(failure)).not.toContain(SENTINEL)
      expect(target.backend.withActiveSecret).not.toHaveBeenCalled()
      expect(target.transport.send).not.toHaveBeenCalled()
    }
  })

  it('rejects request getters, extra fields, wrong descriptor and oversized bodies before authority', async () => {
    let getterRead = false
    const accessor = Object.defineProperty({ ...REQUEST, extra: SENTINEL }, 'handle', {
      enumerable: true,
      get() {
        getterRead = true
        throw new Error(SENTINEL)
      },
    })
    const target = harness()
    await target.proxy.start()
    const accessorFailure = await target.client.request(accessor as never).catch((error: unknown) => error)
    expect(accessorFailure).toEqual(new OpaqueCredentialProxyError('INVALID_INPUT'))
    expect(getterRead).toBe(false)
    await expect(target.client.request({ ...REQUEST, descriptorRevision: 2 }))
      .rejects.toMatchObject({ code: 'DESCRIPTOR_DENIED' })
    await expect(target.client.request({ ...REQUEST, body: new Uint8Array(1025) }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(target.authority.authorizeUse).not.toHaveBeenCalled()
  })

  it('makes capability callback single-use and zeroes both replay buffers', async () => {
    const buffers: Uint8Array[] = []
    const replay: OpaqueSecretBackendPort['withActiveSecret'] = async (_locator, _capability, consume) => {
      const first = new TextEncoder().encode(SENTINEL)
      const second = new TextEncoder().encode(SENTINEL)
      buffers.push(first, second)
      await Promise.allSettled([consume(first), consume(second)])
    }
    const target = harness({ backend: replay })
    await target.proxy.start()
    await expect(target.client.request(REQUEST)).rejects.toMatchObject({ code: 'CAPABILITY_REPLAYED' })
    expect(target.transport.send).toHaveBeenCalledOnce()
    expect(buffers.every(buffer => buffer.every(byte => byte === 0))).toBe(true)
  })

  it('expires capability at the exact deadline before transport', async () => {
    let now = 100
    const delayed: OpaqueSecretBackendPort['withActiveSecret'] = async (_locator, _capability, consume) => {
      now = 110
      const owned = new TextEncoder().encode(SENTINEL)
      await consume(owned)
      expect(owned.every(byte => byte === 0)).toBe(true)
    }
    const target = harness({ nowMs: () => now, backend: delayed })
    await target.proxy.start()
    await expect(target.client.request(REQUEST)).rejects.toMatchObject({ code: 'CAPABILITY_EXPIRED' })
    expect(target.transport.send).not.toHaveBeenCalled()
  })

  it('checks rate and concurrent quotas before authority/backend use', async () => {
    const rate = harness({ maxRequests: 1 })
    await rate.proxy.start()
    await expect(rate.client.request(REQUEST)).resolves.toMatchObject({ status: 200 })
    await expect(rate.client.request(REQUEST)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    expect(rate.authority.authorizeUse).toHaveBeenCalledOnce()

    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const concurrent = harness({
      send: async () => {
        await blocked
        return { status: 200, body: null }
      },
    })
    await concurrent.proxy.start()
    const first = concurrent.client.request(REQUEST)
    const firstOutcome = first.catch((error: unknown) => error)
    await vi.waitFor(() => expect(concurrent.transport.send).toHaveBeenCalledOnce())
    await expect(concurrent.client.request(REQUEST)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    release()
    await expect(firstOutcome).resolves.toMatchObject({ status: 200 })
  })

  it('times out, zeroes authorization immediately, and never accepts a late transport result', async () => {
    let resolveLate!: (value: { status: number; body: null }) => void
    let authorization: Uint8Array | undefined
    const target = harness({
      descriptor: { ...DESCRIPTOR, timeoutMs: 5 },
      send: async input => {
        authorization = input.authorization
        return new Promise(resolve => { resolveLate = resolve })
      },
    })
    await target.proxy.start()
    const outcome = target.client.request(REQUEST).catch((error: unknown) => error)
    await vi.waitFor(() => expect(authorization).toBeDefined())
    await expect(outcome).resolves.toMatchObject({ code: 'TIMEOUT' })
    expect(authorization?.every(byte => byte === 0)).toBe(true)
    resolveLate({ status: 200, body: null })
  })

  it('fences revoke, denies new admission, and drains the actual late operation', async () => {
    let resolveLate!: (value: { status: number; body: null }) => void
    const target = harness({ send: async () => new Promise(resolve => { resolveLate = resolve }) })
    await target.proxy.start()
    const outcome = target.client.request(REQUEST).catch((error: unknown) => error)
    await vi.waitFor(() => expect(target.transport.send).toHaveBeenCalledOnce())
    let drained = false
    const fence = target.proxy.fenceRevokedHandle(HANDLE).then(() => { drained = true })
    await expect(outcome).resolves.toMatchObject({ code: 'ABORTED' })
    expect(drained).toBe(false)
    await expect(target.client.request(REQUEST)).rejects.toMatchObject({ code: 'NOT_AVAILABLE' })
    resolveLate({ status: 200, body: null })
    await fence
    expect(drained).toBe(true)
  })

  it('coalesces start, snapshots attestation methods, and stop drains an in-progress start', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const target = harness()
    target.deps.authority.attest = vi.fn(async () => {
      await blocked
      return {
        schemaVersion: 1 as const,
        status: 'trusted' as const,
        authorityId: 'credential-authority-1',
        policyRevision: 'authority-policy-1',
        capabilities: ['exact-active-binding', 'revocation-generation-fence'] as const,
      }
    })
    const proxy = makeOpaqueCredentialProxy(target.deps)
    const first = proxy.start()
    const second = proxy.start()
    expect(second).toBe(first)
    let stopped = false
    const stopping = proxy.stop().then(() => { stopped = true })
    expect(stopped).toBe(false)
    release()
    await expect(first).rejects.toMatchObject({ code: 'ABORTED' })
    await stopping
    expect(stopped).toBe(true)
  })

  it('rejects rich/accessor transport results without evaluating body or exposing bytes', async () => {
    let getterRead = false
    const target = harness({
      send: async () => Object.defineProperty({ status: 200, extra: SENTINEL }, 'body', {
        enumerable: true,
        get() {
          getterRead = true
          return new TextEncoder().encode(SENTINEL)
        },
      }) as never,
    })
    await target.proxy.start()
    const failure = await target.client.request(REQUEST).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'RESPONSE_REJECTED' })
    expect(String(failure)).not.toContain(SENTINEL)
    expect(getterRead).toBe(false)
  })

  it('redacts abort reasons, raw authority/backend/transport errors, and stops idempotently', async () => {
    const controller = new AbortController()
    controller.abort(new Error(SENTINEL))
    const aborted = harness()
    await aborted.proxy.start()
    const abortFailure = await aborted.client.request({ ...REQUEST, signal: controller.signal })
      .catch((error: unknown) => error)
    expect(abortFailure).toEqual(new OpaqueCredentialProxyError('ABORTED'))
    expect(String(abortFailure)).not.toContain(SENTINEL)
    expect(aborted.authority.authorizeUse).not.toHaveBeenCalled()
    await aborted.proxy.stop()
    await aborted.proxy.stop()
    await expect(aborted.client.request(REQUEST)).rejects.toMatchObject({ code: 'STOPPED' })
  })
})

import { readFileSync } from 'node:fs'
import type {
  OpaqueCredentialDescriptorV1,
  OpaqueCredentialLocatorV1,
  OpaqueSecretHandle,
} from '@aisy/core'
import {
  makeIsolatedOpaqueByteTransport,
  makeProcessOpaqueSecretBackend,
  OpaqueProcessAdapterError,
  type OpaqueByteProxyProcessAttestationV1,
  type OpaqueByteProxyProcessPort,
  type OpaqueSecretBackendId,
  type OpaqueSecretBackendProcessAttestationV1,
  type OpaqueSecretProcessPort,
} from './opaque-secret-process-adapters.js'

const LOCATOR = Object.freeze({
  schemaVersion: 1,
  handle: 'opaque-handle-00000001' as OpaqueSecretHandle,
  operatorId: 'operator-1',
  profileId: 'profile-1',
  connectionId: 'connection-1',
  connectionRevision: 'connection-revision-1',
  provider: 'openai',
  providerSlot: 'openai-api-key',
  credentialRevision: 3,
  generation: 5,
  state: 'active',
} satisfies OpaqueCredentialLocatorV1)

const DESCRIPTOR = Object.freeze({
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
  timeoutMs: 5_000,
  requestMaxBytes: 32,
  responseMaxBytes: 32,
  responseMode: 'status-only',
  redirects: 'deny',
} satisfies OpaqueCredentialDescriptorV1)

const SIGNAL = new AbortController().signal
const SECRET = new TextEncoder().encode('synthetic-sentinel-secret')

function backendAttestation(
  backendId: OpaqueSecretBackendId = 'macos-keychain',
): OpaqueSecretBackendProcessAttestationV1 {
  return {
    schemaVersion: 1,
    status: 'trusted',
    backendId,
    policyRevision: 'backend-policy-1',
    trustRoot: backendId === 'vault-agent' ? 'external' : 'private-os',
    secretResolution: 'callback-only',
    binding: 'exact',
    deletion: 'confirmed',
    plaintextFallback: 'disabled',
  }
}

function transportAttestation(): OpaqueByteProxyProcessAttestationV1 {
  return {
    schemaVersion: 1,
    status: 'trusted',
    transportId: 'isolated-byte-proxy',
    policyRevision: 'transport-policy-1',
    isolation: 'isolated-one-shot-byte-proxy',
    byteOwnedAuthorization: true,
    dnsPolicy: 'resolve-public-and-pin',
    tlsPolicy: 'exact-hostname-sni-system-ca-tls12',
    redirects: 'deny',
    proxyEnvironment: 'disabled',
    connectionReuse: 'disabled',
    bounds: 'request-response-decompressed-chunks',
  }
}

describe('process-backed opaque secret backend', () => {
  it.each([
    ['macos-keychain', 'private-os'],
    ['linux-libsecret', 'private-os'],
    ['vault-agent', 'external'],
  ] as const)('requires the code-owned trust root for %s and maps the exact attestation',
    async (backendId, trustRoot) => {
      const operations: unknown[] = []
      const process: OpaqueSecretProcessPort = {
        async run(operation) {
          operations.push(operation)
          return backendAttestation(backendId)
        },
      }
      const backend = makeProcessOpaqueSecretBackend({
        backendId,
        policyRevision: 'backend-policy-1',
        process,
        executable: '/tmp/not-allowed',
        argv: ['dump-secret'],
        env: { TOKEN: 'not-allowed' },
        fallback: 'plaintext',
      } as never)

      await expect(backend.attest(SIGNAL)).resolves.toEqual({
        schemaVersion: 1,
        status: 'trusted',
        backendId,
        policyRevision: 'backend-policy-1',
        capabilities: ['resolve-callback', 'exact-binding', 'confirmed-delete'],
      })
      expect(operations).toEqual([{
        operation: 'attest-backend',
        backendId,
        policyRevision: 'backend-policy-1',
      }])
      expect(backendAttestation(backendId).trustRoot).toBe(trustRoot)
    })

  it('sends only resolve-active plus the exact locator, never the capability', async () => {
    const operations: unknown[] = []
    const rawSecret = new Uint8Array(SECRET)
    const process: OpaqueSecretProcessPort = {
      async run(operation) {
        operations.push(operation)
        return operation.operation === 'attest-backend'
          ? backendAttestation()
          : { schemaVersion: 1, status: 'resolved', locator: LOCATOR, secret: rawSecret }
      },
    }
    const backend = makeProcessOpaqueSecretBackend({
      backendId: 'macos-keychain',
      policyRevision: 'backend-policy-1',
      process,
    })
    let consumed: Uint8Array | undefined

    const result = await backend.withActiveSecret(
      LOCATOR,
      Object.freeze({ serializableCapability: 'must-not-cross' }) as never,
      async (ownedSecret) => {
        consumed = ownedSecret
        expect(ownedSecret).not.toBe(rawSecret)
        expect(ownedSecret).toEqual(SECRET)
        expect(rawSecret.every((byte) => byte === 0)).toBe(true)
      },
      SIGNAL,
    )

    expect(result).toBeUndefined()
    expect(consumed?.every((byte) => byte === 0)).toBe(true)
    expect(operations).toEqual([{
      operation: 'resolve-active',
      backendId: 'macos-keychain',
      policyRevision: 'backend-policy-1',
      locator: LOCATOR,
    }])
    expect(JSON.stringify(operations)).not.toContain('serializableCapability')
  })

  it('zeroes fresh callback bytes when the consumer faults', async () => {
    let consumed: Uint8Array | undefined
    const rawSecret = new Uint8Array(SECRET)
    const process: OpaqueSecretProcessPort = {
      async run() {
        return { schemaVersion: 1, status: 'resolved', locator: LOCATOR, secret: rawSecret }
      },
    }
    const backend = makeProcessOpaqueSecretBackend({
      backendId: 'macos-keychain', policyRevision: 'backend-policy-1', process,
    })
    const fault = new Error('trusted-consumer-fault')

    await expect(backend.withActiveSecret(LOCATOR, {} as never, async (ownedSecret) => {
      consumed = ownedSecret
      throw fault
    }, SIGNAL)).rejects.toBe(fault)
    expect(rawSecret.every((byte) => byte === 0)).toBe(true)
    expect(consumed?.every((byte) => byte === 0)).toBe(true)
  })

  it('redacts raw process failures and fails closed on wrong or rich attestations', async () => {
    const sentinel = 'raw process stderr contains synthetic secret'
    const failed = makeProcessOpaqueSecretBackend({
      backendId: 'macos-keychain',
      policyRevision: 'backend-policy-1',
      process: { run: async () => { throw new Error(sentinel) } },
    })
    const failure = await failed.attest(SIGNAL).catch((error: unknown) => error)
    expect(failure).toEqual(new OpaqueProcessAdapterError('BACKEND_ATTESTATION_FAILED'))
    expect(String(failure)).not.toContain(sentinel)

    for (const value of [
      { ...backendAttestation(), trustRoot: 'external' },
      { ...backendAttestation(), plaintextFallback: 'available' },
      { ...backendAttestation(), detail: 'rich' },
    ]) {
      const backend = makeProcessOpaqueSecretBackend({
        backendId: 'macos-keychain',
        policyRevision: 'backend-policy-1',
        process: { run: async () => value },
      })
      await expect(backend.attest(SIGNAL)).rejects.toEqual(
        new OpaqueProcessAdapterError('BACKEND_ATTESTATION_REJECTED'),
      )
    }
  })

  it('denies accessor and extra resolve results without executing getters', async () => {
    for (const variant of ['extra-accessor', 'locator-accessor'] as const) {
      let getterCalls = 0
      const rawSecret = new Uint8Array(SECRET)
      const response: Record<string, unknown> = {
        schemaVersion: 1,
        status: 'resolved',
        locator: LOCATOR,
        secret: rawSecret,
      }
      Object.defineProperty(response, variant === 'extra-accessor' ? 'detail' : 'locator', {
        enumerable: true,
        get() {
          getterCalls += 1
          return variant === 'locator-accessor' ? LOCATOR : 'not-allowed'
        },
      })
      const backend = makeProcessOpaqueSecretBackend({
        backendId: 'macos-keychain',
        policyRevision: 'backend-policy-1',
        process: { run: async () => response },
      })

      await expect(backend.withActiveSecret(LOCATOR, {} as never, async () => undefined, SIGNAL))
        .rejects.toEqual(new OpaqueProcessAdapterError('BACKEND_RESPONSE_REJECTED'))
      expect(getterCalls).toBe(0)
      expect(rawSecret.every((byte) => byte === 0)).toBe(true)
    }
  })
})

describe('isolated opaque byte transport', () => {
  it('maps only a complete isolated one-shot attestation', async () => {
    const operations: unknown[] = []
    const process: OpaqueByteProxyProcessPort = {
      async run(operation) {
        operations.push(operation)
        return transportAttestation()
      },
    }
    const transport = makeIsolatedOpaqueByteTransport({
      transportId: 'isolated-byte-proxy',
      policyRevision: 'transport-policy-1',
      process,
      executable: '/tmp/curl',
      env: { HTTPS_PROXY: 'not-allowed' },
      url: 'https://attacker.invalid',
      headers: { authorization: 'not-allowed' },
    } as never)

    await expect(transport.attest(SIGNAL)).resolves.toEqual({
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
    })
    expect(operations).toEqual([{
      operation: 'attest-transport',
      transportId: 'isolated-byte-proxy',
      policyRevision: 'transport-policy-1',
    }])
  })

  it('forwards descriptor, authorization, and body bytes by identity with no override surface',
    async () => {
      const authorization = new Uint8Array(SECRET)
      const requestBody = new Uint8Array([1, 2, 3])
      let exchange: Record<string, unknown> | undefined
      const process: OpaqueByteProxyProcessPort = {
        async run(operation) {
          exchange = operation as unknown as Record<string, unknown>
          return { status: 200, body: null }
        },
      }
      const transport = makeIsolatedOpaqueByteTransport({
        transportId: 'isolated-byte-proxy', policyRevision: 'transport-policy-1', process,
      })

      await expect(transport.send({
        requestId: 'request-1',
        descriptor: DESCRIPTOR,
        authorization,
        body: requestBody,
        signal: SIGNAL,
      })).resolves.toEqual({ status: 200, body: null })
      expect(exchange).toEqual({
        operation: 'exchange',
        requestId: 'request-1',
        descriptor: DESCRIPTOR,
        authorization,
        body: requestBody,
      })
      expect(exchange?.['descriptor']).toBe(DESCRIPTOR)
      expect(exchange?.['authorization']).toBe(authorization)
      expect(exchange?.['body']).toBe(requestBody)
      expect(exchange).not.toHaveProperty('url')
      expect(exchange).not.toHaveProperty('headers')
      expect(exchange).not.toHaveProperty('command')
      expect(exchange).not.toHaveProperty('env')
    })

  it('fails closed on wrong or rich transport attestations', async () => {
    for (const value of [
      { ...transportAttestation(), isolation: 'shared-http-client' },
      { ...transportAttestation(), dnsPolicy: 'system-default' },
      { ...transportAttestation(), tlsPolicy: 'tls12-without-sni' },
      { ...transportAttestation(), redirects: 'follow' },
      { ...transportAttestation(), proxyEnvironment: 'enabled' },
      { ...transportAttestation(), connectionReuse: 'enabled' },
      { ...transportAttestation(), bounds: 'response-only' },
      { ...transportAttestation(), detail: 'rich' },
    ]) {
      const transport = makeIsolatedOpaqueByteTransport({
        transportId: 'isolated-byte-proxy',
        policyRevision: 'transport-policy-1',
        process: { run: async () => value },
      })
      await expect(transport.attest(SIGNAL)).rejects.toEqual(
        new OpaqueProcessAdapterError('TRANSPORT_ATTESTATION_REJECTED'),
      )
    }
  })

  it('redacts raw exchange failures', async () => {
    const sentinel = 'raw proxy output contains synthetic secret'
    const transport = makeIsolatedOpaqueByteTransport({
      transportId: 'isolated-byte-proxy',
      policyRevision: 'transport-policy-1',
      process: { run: async () => { throw new Error(sentinel) } },
    })
    const failure = await transport.send({
      requestId: 'request-1', descriptor: DESCRIPTOR, authorization: new Uint8Array(SECRET),
      body: null, signal: SIGNAL,
    }).catch((error: unknown) => error)
    expect(failure).toEqual(new OpaqueProcessAdapterError('TRANSPORT_EXCHANGE_FAILED'))
    expect(String(failure)).not.toContain(sentinel)
  })

  it('denies accessor or extra response fields without getter execution and zeroes rejected body',
    async () => {
      for (const variant of ['extra-accessor', 'body-accessor'] as const) {
        let getterCalls = 0
        const body = new Uint8Array([7, 8, 9])
        const response: Record<string, unknown> = { status: 200, body }
        Object.defineProperty(response, variant === 'extra-accessor' ? 'detail' : 'body', {
          enumerable: true,
          get() {
            getterCalls += 1
            return body
          },
        })
        const transport = makeIsolatedOpaqueByteTransport({
          transportId: 'isolated-byte-proxy',
          policyRevision: 'transport-policy-1',
          process: { run: async () => response },
        })

        await expect(transport.send({
          requestId: 'request-1', descriptor: DESCRIPTOR,
          authorization: new Uint8Array(SECRET), body: null, signal: SIGNAL,
        })).rejects.toEqual(new OpaqueProcessAdapterError('TRANSPORT_RESPONSE_REJECTED'))
        expect(getterCalls).toBe(0)
        if (variant === 'extra-accessor') expect(body.every((byte) => byte === 0)).toBe(true)
      }
    })

  it('enforces request, response, and status-only body bounds and zeroes rejected bodies', async () => {
    const responses: unknown[] = []
    const process = { run: vi.fn(async (): Promise<unknown> =>
      responses.shift() ?? { status: 200, body: null }) }
    const transport = makeIsolatedOpaqueByteTransport({
      transportId: 'isolated-byte-proxy', policyRevision: 'transport-policy-1', process,
    })
    await expect(transport.send({
      requestId: 'request-1', descriptor: DESCRIPTOR,
      authorization: new Uint8Array(SECRET), body: new Uint8Array(33), signal: SIGNAL,
    })).rejects.toEqual(new OpaqueProcessAdapterError('TRANSPORT_RESPONSE_REJECTED'))
    expect(process.run).not.toHaveBeenCalled()

    const oversized = new Uint8Array(33).fill(9)
    responses.push({ status: 200, body: oversized })
    await expect(transport.send({
      requestId: 'request-2', descriptor: DESCRIPTOR,
      authorization: new Uint8Array(SECRET), body: null, signal: SIGNAL,
    })).rejects.toEqual(new OpaqueProcessAdapterError('TRANSPORT_RESPONSE_REJECTED'))
    expect(oversized.every((byte) => byte === 0)).toBe(true)

    const statusBody = new Uint8Array([1])
    responses.push({ status: 200, body: statusBody })
    await expect(transport.send({
      requestId: 'request-3',
      descriptor: { ...DESCRIPTOR, responseMode: 'status-only' },
      authorization: new Uint8Array(SECRET), body: null, signal: SIGNAL,
    })).rejects.toEqual(new OpaqueProcessAdapterError('TRANSPORT_RESPONSE_REJECTED'))
    expect(statusBody[0]).toBe(0)
  })

  it('rejects rich descriptor accessors before the injected proxy is reached', async () => {
    let getterCalls = 0
    const descriptor = { ...DESCRIPTOR } as Record<string, unknown>
    Object.defineProperty(descriptor, 'url', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'https://attacker.invalid'
      },
    })
    const process = { run: vi.fn(async () => ({ status: 200, body: null })) }
    const transport = makeIsolatedOpaqueByteTransport({
      transportId: 'isolated-byte-proxy', policyRevision: 'transport-policy-1', process,
    })

    await expect(transport.send({
      requestId: 'request-1', descriptor: descriptor as never,
      authorization: new Uint8Array(SECRET), body: null, signal: SIGNAL,
    })).rejects.toEqual(new OpaqueProcessAdapterError('TRANSPORT_RESPONSE_REJECTED'))
    expect(getterCalls).toBe(0)
    expect(process.run).not.toHaveBeenCalled()
  })
})

describe('offline composition boundary', () => {
  it('does not import or wire the adapters in the live CLI', () => {
    const source = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('opaque-secret-process-adapters')
    expect(source).not.toContain('makeProcessOpaqueSecretBackend')
    expect(source).not.toContain('makeIsolatedOpaqueByteTransport')
  })

  it('contains no direct process or network implementation', () => {
    const source = readFileSync(new URL('./opaque-secret-process-adapters.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/node:(?:child_process|http|https|net|tls)/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/\bspawn\s*\(/)
    expect(source).not.toMatch(/\bexec(?:File)?\s*\(/)
  })
})

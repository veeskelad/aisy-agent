import { describe, expect, it, vi } from 'vitest'

import type { ApiCredentialBinding } from './api-key-setup-driver.js'
import {
  ANTHROPIC_CREDENTIAL_VALIDATION_URL,
  makeAnthropicApiCredentialProviderValidator,
  makeOpenAIApiCredentialProviderValidator,
  makeOpenRouterApiCredentialProviderValidator,
  OPENAI_CREDENTIAL_VALIDATION_URL,
  OPENROUTER_CREDENTIAL_VALIDATION_URL,
  type ApiCredentialValidationProxyPort,
} from './openai-api-credential-validator.js'

const BINDING: ApiCredentialBinding = {
  connectionId: 'openai-primary',
  provider: 'openai',
  vaultKey: 'AISY_PROVIDER_OPENAI_KEY',
}

function harness(response: unknown = { status: 200 }): {
  validator: ReturnType<typeof makeOpenAIApiCredentialProviderValidator>
  execute: ReturnType<typeof vi.fn<ApiCredentialValidationProxyPort['execute']>>
} {
  const execute = vi.fn<ApiCredentialValidationProxyPort['execute']>(async () => response)
  return {
    execute,
    validator: makeOpenAIApiCredentialProviderValidator({ proxy: { execute } }),
  }
}

describe('OpenAI API credential validator', () => {
  it('validates a staged opaque handle with one fixed status-only request', async () => {
    const h = harness()
    await expect(h.validator.validateStaged(BINDING, 'credential-1')).resolves.toEqual({
      ok: true,
      safeDetail: 'OpenAI API credential is accepted.',
    })

    expect(h.execute).toHaveBeenCalledOnce()
    const request = h.execute.mock.calls[0]?.[0]
    expect(request).toEqual({
      provider: 'openai',
      authProtocol: 'authorization-bearer',
      credential: {
        kind: 'staged',
        vaultKey: 'AISY_PROVIDER_OPENAI_KEY',
        transactionId: 'credential-1',
      },
      method: 'GET',
      url: OPENAI_CREDENTIAL_VALIDATION_URL,
      redirect: 'error',
      responseMode: 'status-only',
      timeoutMs: 10_000,
    })
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request?.credential)).toBe(true)
    expect(JSON.stringify(request)).not.toContain('Bearer')
  })

  it('uses only the active opaque slot for a health validation', async () => {
    const h = harness({ status: 200 })
    await expect(h.validator.validateActive(BINDING)).resolves.toMatchObject({ ok: true })
    expect(h.execute.mock.calls[0]?.[0].credential).toEqual({
      kind: 'active',
      vaultKey: 'AISY_PROVIDER_OPENAI_KEY',
    })
  })

  it.each([
    [
      'anthropic',
      makeAnthropicApiCredentialProviderValidator,
      ANTHROPIC_CREDENTIAL_VALIDATION_URL,
      'anthropic-x-api-key-2023-06-01',
    ],
    [
      'openrouter',
      makeOpenRouterApiCredentialProviderValidator,
      OPENROUTER_CREDENTIAL_VALIDATION_URL,
      'authorization-bearer',
    ],
  ] as const)('uses the exact %s endpoint and auth protocol', async (
    provider,
    factory,
    url,
    authProtocol,
  ) => {
    const execute = vi.fn<ApiCredentialValidationProxyPort['execute']>(async () => ({ status: 200 }))
    const validator = factory({ proxy: { execute } })
    const binding = {
      connectionId: `${provider}-primary`,
      provider,
      vaultKey: `AISY_PROVIDER_${provider.toUpperCase()}_KEY`,
    }
    await expect(validator.validateStaged(binding, 'credential-1')).resolves.toMatchObject({ ok: true })
    expect(execute).toHaveBeenCalledWith({
      provider,
      authProtocol,
      credential: {
        kind: 'staged',
        vaultKey: binding.vaultKey,
        transactionId: 'credential-1',
      },
      method: 'GET',
      url,
      redirect: 'error',
      responseMode: 'status-only',
      timeoutMs: 10_000,
    })
  })

  it('does not let one provider validator use another provider binding', async () => {
    const execute = vi.fn<ApiCredentialValidationProxyPort['execute']>(async () => ({ status: 200 }))
    const anthropic = makeAnthropicApiCredentialProviderValidator({ proxy: { execute } })
    await expect(anthropic.validateActive(BINDING)).resolves.toMatchObject({
      ok: false,
      errorCode: 'API_CREDENTIAL_BINDING_REJECTED',
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not let a provider resolve another provider vault slot', async () => {
    const execute = vi.fn<ApiCredentialValidationProxyPort['execute']>(async () => ({ status: 200 }))
    const anthropic = makeAnthropicApiCredentialProviderValidator({ proxy: { execute } })
    await expect(anthropic.validateActive({
      connectionId: 'anthropic-primary',
      provider: 'anthropic',
      vaultKey: 'AISY_PROVIDER_OPENAI_KEY',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'API_CREDENTIAL_BINDING_REJECTED',
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'API_CREDENTIAL_REJECTED'],
    [403, 'API_CREDENTIAL_REJECTED'],
    [408, 'API_CREDENTIAL_TIMEOUT'],
    [429, 'API_CREDENTIAL_RATE_LIMITED'],
    [503, 'API_CREDENTIAL_PROVIDER_UNAVAILABLE'],
    [204, 'API_CREDENTIAL_PROTOCOL_FAILED'],
    [302, 'API_CREDENTIAL_PROTOCOL_FAILED'],
  ])('maps status %i to a stable redacted result', async (status, errorCode) => {
    const h = harness({ status })
    await expect(h.validator.validateActive(BINDING)).resolves.toEqual(
      expect.objectContaining({ ok: false, errorCode }),
    )
  })

  it('rejects the wrong provider and malformed transaction before proxy I/O', async () => {
    const h = harness()
    await expect(h.validator.validateActive({ ...BINDING, provider: 'openrouter' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'API_CREDENTIAL_BINDING_REJECTED',
    })
    await expect(h.validator.validateStaged(BINDING, '../credential')).resolves.toMatchObject({
      ok: false,
      errorCode: 'API_CREDENTIAL_BINDING_REJECTED',
    })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('rejects proxy output containing body or metadata instead of propagating it', async () => {
    const h = harness({ status: 200, body: 'upstream-private-body' })
    const validation = await h.validator.validateActive(BINDING)
    expect(validation).toEqual({
      ok: false,
      safeDetail: 'OpenAI credential validation returned an invalid response.',
      errorCode: 'API_CREDENTIAL_PROTOCOL_FAILED',
    })
    expect(JSON.stringify(validation)).not.toContain('upstream-private-body')
  })

  it('redacts proxy exceptions and validates timeout configuration', async () => {
    const proxy: ApiCredentialValidationProxyPort = {
      execute: vi.fn(async () => { throw new Error('raw-upstream-provider-detail') }),
    }
    const validator = makeOpenAIApiCredentialProviderValidator({ proxy, timeoutMs: 1_000 })
    const validation = await validator.validateActive(BINDING)
    expect(validation).toEqual({
      ok: false,
      safeDetail: 'OpenAI credential validation failed.',
      errorCode: 'API_CREDENTIAL_VALIDATION_FAILED',
    })
    expect(JSON.stringify(validation)).not.toContain('raw-upstream-provider-detail')
    expect(() => makeOpenAIApiCredentialProviderValidator({ proxy, timeoutMs: 999 }))
      .toThrow('INVALID_API_CREDENTIAL_VALIDATION_TIMEOUT')
  })
})

import type { BrainValidationResult } from '../onboarding/brain-connections.js'
import type { ApiCredentialProviderValidator } from './api-credential-ingress.js'
import type { ApiCredentialBinding } from './api-key-setup-driver.js'

export const OPENAI_CREDENTIAL_VALIDATION_URL = 'https://api.openai.com/v1/models'
export const ANTHROPIC_CREDENTIAL_VALIDATION_URL = 'https://api.anthropic.com/v1/models'
export const OPENROUTER_CREDENTIAL_VALIDATION_URL = 'https://openrouter.ai/api/v1/models'

export type NativeApiCredentialProvider = 'openai' | 'anthropic' | 'openrouter'
export type ApiCredentialAuthProtocol =
  | 'authorization-bearer'
  | 'anthropic-x-api-key-2023-06-01'

export type ApiCredentialLocator =
  | Readonly<{ kind: 'staged'; vaultKey: string; transactionId: string }>
  | Readonly<{ kind: 'active'; vaultKey: string }>

/**
 * A code-owned, status-only request. The proxy resolves the opaque locator and
 * injects authentication inside the network boundary; callers cannot retrieve
 * credential bytes through this contract.
 */
export interface ApiCredentialValidationProxyRequest {
  provider: NativeApiCredentialProvider
  authProtocol: ApiCredentialAuthProtocol
  credential: ApiCredentialLocator
  method: 'GET'
  url:
    | typeof OPENAI_CREDENTIAL_VALIDATION_URL
    | typeof ANTHROPIC_CREDENTIAL_VALIDATION_URL
    | typeof OPENROUTER_CREDENTIAL_VALIDATION_URL
  redirect: 'error'
  responseMode: 'status-only'
  timeoutMs: number
}

export interface ApiCredentialValidationProxyPort {
  /** Must not return headers, body, final URL, or credential material. */
  execute(request: Readonly<ApiCredentialValidationProxyRequest>): Promise<unknown>
}

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const VAULT_KEY = /^AISY_PROVIDER_[A-Z0-9_]{1,96}_KEY$/

function validBinding(binding: ApiCredentialBinding, provider: NativeApiCredentialProvider): boolean {
  return binding.provider === provider && ID.test(binding.connectionId) &&
    VAULT_KEY.test(binding.vaultKey)
}

function exactStatus(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'status') return null
  const status = (value as { status?: unknown }).status
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null
}

function result(ok: boolean, safeDetail: string, errorCode?: string): BrainValidationResult {
  return ok
    ? { ok: true, safeDetail }
    : { ok: false, safeDetail, ...(errorCode === undefined ? {} : { errorCode }) }
}

function classify(value: unknown, displayName: string): BrainValidationResult {
  const status = exactStatus(value)
  if (status === null) {
    return result(false, `${displayName} credential validation returned an invalid response.`,
      'API_CREDENTIAL_PROTOCOL_FAILED')
  }
  if (status === 200) {
    return result(true, `${displayName} API credential is accepted.`)
  }
  if (status === 401 || status === 403) {
    return result(false, `${displayName} API credential was rejected.`, 'API_CREDENTIAL_REJECTED')
  }
  if (status === 408 || status === 504) {
    return result(false, `${displayName} credential validation timed out.`, 'API_CREDENTIAL_TIMEOUT')
  }
  if (status === 429) {
    return result(false, `${displayName} credential validation was rate limited.`,
      'API_CREDENTIAL_RATE_LIMITED')
  }
  if (status >= 500) {
    return result(false, `${displayName} credential validation is temporarily unavailable.`,
      'API_CREDENTIAL_PROVIDER_UNAVAILABLE')
  }
  return result(false, `${displayName} credential validation returned an unexpected status.`,
    'API_CREDENTIAL_PROTOCOL_FAILED')
}

/**
 * Provider credential validator backed by an opaque, credential-injecting proxy.
 * The endpoint and all request semantics are fixed in code. The validator does
 * not accept a URL, headers, request body, or redirect policy from configuration.
 */
function makeCodeOwnedApiCredentialProviderValidator(input: {
  proxy: ApiCredentialValidationProxyPort
  timeoutMs?: number
  provider: NativeApiCredentialProvider
  displayName: string
  url: ApiCredentialValidationProxyRequest['url']
  authProtocol: ApiCredentialAuthProtocol
  vaultKey: string
}): ApiCredentialProviderValidator {
  const timeoutMs = input.timeoutMs ?? 10_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error('INVALID_API_CREDENTIAL_VALIDATION_TIMEOUT')
  }

  const validate = async (
    binding: ApiCredentialBinding,
    credential: ApiCredentialLocator,
  ): Promise<BrainValidationResult> => {
    if (!validBinding(binding, input.provider) || binding.vaultKey !== input.vaultKey ||
      binding.vaultKey !== credential.vaultKey ||
      (credential.kind === 'staged' && !ID.test(credential.transactionId))) {
      return result(false, `${input.displayName} credential binding is invalid.`,
        'API_CREDENTIAL_BINDING_REJECTED')
    }
    const frozenCredential = Object.freeze({ ...credential }) as ApiCredentialLocator
    const request = Object.freeze<ApiCredentialValidationProxyRequest>({
      provider: input.provider,
      authProtocol: input.authProtocol,
      credential: frozenCredential,
      method: 'GET',
      url: input.url,
      redirect: 'error',
      responseMode: 'status-only',
      timeoutMs,
    })
    try {
      return classify(await input.proxy.execute(request), input.displayName)
    } catch {
      return result(false, `${input.displayName} credential validation failed.`,
        'API_CREDENTIAL_VALIDATION_FAILED')
    }
  }

  return Object.freeze<ApiCredentialProviderValidator>({
    validateStaged(binding, transactionId) {
      return validate(binding, { kind: 'staged', vaultKey: binding.vaultKey, transactionId })
    },
    validateActive(binding) {
      return validate(binding, { kind: 'active', vaultKey: binding.vaultKey })
    },
  })
}

export function makeOpenAIApiCredentialProviderValidator(input: {
  proxy: ApiCredentialValidationProxyPort
  timeoutMs?: number
}): ApiCredentialProviderValidator {
  return makeCodeOwnedApiCredentialProviderValidator({
    ...input,
    provider: 'openai',
    displayName: 'OpenAI',
    url: OPENAI_CREDENTIAL_VALIDATION_URL,
    authProtocol: 'authorization-bearer',
    vaultKey: 'AISY_PROVIDER_OPENAI_KEY',
  })
}

export function makeAnthropicApiCredentialProviderValidator(input: {
  proxy: ApiCredentialValidationProxyPort
  timeoutMs?: number
}): ApiCredentialProviderValidator {
  return makeCodeOwnedApiCredentialProviderValidator({
    ...input,
    provider: 'anthropic',
    displayName: 'Anthropic',
    url: ANTHROPIC_CREDENTIAL_VALIDATION_URL,
    authProtocol: 'anthropic-x-api-key-2023-06-01',
    vaultKey: 'AISY_PROVIDER_ANTHROPIC_KEY',
  })
}

export function makeOpenRouterApiCredentialProviderValidator(input: {
  proxy: ApiCredentialValidationProxyPort
  timeoutMs?: number
}): ApiCredentialProviderValidator {
  return makeCodeOwnedApiCredentialProviderValidator({
    ...input,
    provider: 'openrouter',
    displayName: 'OpenRouter',
    url: OPENROUTER_CREDENTIAL_VALIDATION_URL,
    authProtocol: 'authorization-bearer',
    vaultKey: 'AISY_PROVIDER_OPENROUTER_KEY',
  })
}

// API-key brain intake: validate the key against the provider, then store it
// and make it the default brain in one atomic pair of writes.
//
// This is the path a phone-only operator actually has. Subscription brains need
// a terminal on the agent's host (`claude`/`codex` own their login), so on a
// fresh server the first brain is almost always a key.

import { findProvider } from '@aisy/core'

export type SetupApiProvider = 'anthropic' | 'openai' | 'openrouter'

export type ProviderCredentialResult =
  | { ok: true; model: string }
  | {
      ok: false
      errorCode:
        | 'CREDENTIAL_EMPTY'
        | 'UNSUPPORTED_PROVIDER'
        | 'AUTH_REJECTED'
        | 'VALIDATION_RATE_LIMITED'
        | 'VALIDATION_UNAVAILABLE'
        | 'VAULT_CORRUPT'
        | 'CONFIG_CORRUPT'
        | 'PERSISTENCE_FAILED'
    }

export interface ProviderCredentialSetup {
  validateAndStore(provider: string, credential: string): Promise<ProviderCredentialResult>
}

export interface ProviderCredentialSetupDeps {
  vaultPath: string
  providersPath: string
  exists(path: string): boolean
  readFile(path: string): string
  writePrivateFile(path: string, content: string): void
  renameFile(from: string, to: string): void
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_MODEL: Record<SetupApiProvider, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o',
  // Auto-routing picks whatever is cheap right now, and "whatever" does not
  // reliably do tool calls — an agent that cannot call a tool is a chatbot.
  // Only used when none of the preferred ids came back from /models.
  openrouter: 'openrouter/auto',
}

/** Ordered preference among ids OpenRouter actually reports, best first. */
// Matched against what /models actually reports, so a newer id that OpenRouter
// has not published yet simply does not match — the older entries stay as the
// fallback rather than becoming a broken default.
const OPENROUTER_PREFERRED = [
  'anthropic/claude-sonnet-5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-sonnet-4',
  'openai/gpt-4o',
  'deepseek/deepseek-chat',
] as const

function isSupportedProvider(provider: string): provider is SetupApiProvider {
  return provider === 'anthropic' || provider === 'openai' || provider === 'openrouter'
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** Model ids from an OpenAI-shaped `/models` body; anything else yields none. */
function modelIds(body: unknown): Set<string> {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return new Set()
  const ids = new Set<string>()
  for (const entry of data) {
    const id = (entry as { id?: unknown }).id
    if (typeof id === 'string') ids.add(id)
  }
  return ids
}

function atomicWrite(
  path: string,
  content: string,
  deps: Pick<ProviderCredentialSetupDeps, 'writePrivateFile' | 'renameFile'>,
): void {
  const tempPath = path + '.tmp'
  deps.writePrivateFile(tempPath, content)
  deps.renameFile(tempPath, path)
}

export function makeProviderCredentialSetup(
  deps: ProviderCredentialSetupDeps,
): ProviderCredentialSetup {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 8_000

  return {
    async validateAndStore(provider: string, rawCredential: string): Promise<ProviderCredentialResult> {
      const credential = rawCredential.trim()
      if (credential.length === 0) return { ok: false, errorCode: 'CREDENTIAL_EMPTY' }
      if (!isSupportedProvider(provider)) {
        return { ok: false, errorCode: 'UNSUPPORTED_PROVIDER' }
      }

      const entry = findProvider(provider)
      if (!entry?.keyEnv) return { ok: false, errorCode: 'UNSUPPORTED_PROVIDER' }
      const baseUrl = provider === 'anthropic'
        ? 'https://api.anthropic.com/v1'
        : entry.defaultBaseUrl
      if (!baseUrl) return { ok: false, errorCode: 'UNSUPPORTED_PROVIDER' }

      let status: number
      let body: unknown = null
      try {
        const response = await fetchImpl(baseUrl + '/models', {
          headers: provider === 'anthropic'
            ? { 'x-api-key': credential, 'anthropic-version': '2023-06-01' }
            : { Authorization: 'Bearer ' + credential },
          signal: AbortSignal.timeout(timeoutMs),
        })
        status = response.status
        if (status >= 200 && status < 400) {
          body = await response.json().catch(() => null)
        }
      } catch {
        return { ok: false, errorCode: 'VALIDATION_UNAVAILABLE' }
      }

      if (status === 401 || status === 403) return { ok: false, errorCode: 'AUTH_REJECTED' }
      if (status === 429) return { ok: false, errorCode: 'VALIDATION_RATE_LIMITED' }
      if (status < 200 || status >= 400) {
        return { ok: false, errorCode: 'VALIDATION_UNAVAILABLE' }
      }

      // Pick a model the account can actually reach: a hard-coded id that the
      // provider has since renamed would leave a "connected" brain that fails
      // on the operator's first message.
      const available = modelIds(body)
      const model = provider === 'openrouter'
        ? OPENROUTER_PREFERRED.find((id) => available.has(id)) ?? DEFAULT_MODEL.openrouter
        : DEFAULT_MODEL[provider]

      const vault = deps.exists(deps.vaultPath)
        ? parseObject(deps.readFile(deps.vaultPath))
        : {}
      if (vault === null) return { ok: false, errorCode: 'VAULT_CORRUPT' }

      const providers = deps.exists(deps.providersPath)
        ? parseObject(deps.readFile(deps.providersPath))
        : {}
      if (providers === null) return { ok: false, errorCode: 'CONFIG_CORRUPT' }

      const nextVault = { ...vault, [entry.keyEnv]: credential }
      const nextProviders = { ...providers, default: { provider, model } }

      try {
        atomicWrite(deps.vaultPath, JSON.stringify(nextVault, null, 2) + '\n', deps)
        atomicWrite(deps.providersPath, JSON.stringify(nextProviders, null, 2) + '\n', deps)
      } catch {
        return { ok: false, errorCode: 'PERSISTENCE_FAILED' }
      }
      return { ok: true, model }
    },
  }
}

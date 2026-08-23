import type { BrainConnectionSetupDriver } from '../onboarding/brain-bootstrap-coordinator.js'
import type { AuthChallenge, BrainValidationResult } from '../onboarding/brain-connections.js'

export interface ApiCredentialBinding {
  connectionId: string
  provider: string
  vaultKey: string
}

export interface ApiCredentialEntryChallenge {
  /** Public, one-use capability. It never contains credential bytes. */
  entryCode: string
  expiresAt: string
}

/**
 * Control-plane boundary for API credentials. Implementations own secure
 * entry, secret storage, provider validation and deletion. Neither the driver
 * nor the agent loop can retrieve secret bytes through this interface.
 */
export interface ApiCredentialBroker {
  issue(binding: ApiCredentialBinding): Promise<ApiCredentialEntryChallenge>
  validate(binding: ApiCredentialBinding): Promise<BrainValidationResult>
  revoke(binding: ApiCredentialBinding): Promise<BrainValidationResult>
}

export class ApiKeySetupDriverError extends Error {
  constructor(public readonly code:
    | 'INVALID_API_CREDENTIAL_BINDING'
    | 'UNSAFE_API_CREDENTIAL_CHALLENGE') {
    super(code)
    this.name = 'ApiKeySetupDriverError'
  }
}

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const VAULT_KEY = /^AISY_PROVIDER_[A-Z0-9_]{1,96}_KEY$/
const ENTRY_CODE = /^[A-Za-z0-9_-]{16,32}$/

function validateBinding(value: ApiCredentialBinding): ApiCredentialBinding {
  if (!ID.test(value.connectionId) || !ID.test(value.provider) || !VAULT_KEY.test(value.vaultKey)) {
    throw new ApiKeySetupDriverError('INVALID_API_CREDENTIAL_BINDING')
  }
  return Object.freeze({ ...value })
}

function validateChallenge(value: ApiCredentialEntryChallenge): ApiCredentialEntryChallenge {
  const expiresAt = Date.parse(value.expiresAt)
  if (!ENTRY_CODE.test(value.entryCode) || !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== value.expiresAt) {
    throw new ApiKeySetupDriverError('UNSAFE_API_CREDENTIAL_CHALLENGE')
  }
  return Object.freeze({ ...value })
}

/**
 * Native API setup adapter. Installation is a deterministic no-op; secret
 * material is entered through `aisy brain credential set` in a local/SSH
 * terminal and is never accepted by this driver or returned in a challenge.
 */
export function makeApiKeySetupDriver(input: {
  binding: ApiCredentialBinding
  broker: ApiCredentialBroker
}): BrainConnectionSetupDriver {
  const binding = validateBinding(input.binding)
  return Object.freeze({
    connectionId: binding.connectionId,
    provider: binding.provider,
    authMode: 'api-key',
    runtime: 'native-api',
    detect: async () => ({ installed: true, version: 'native-api-v1' }),
    install: async () => ({ installed: true, version: 'native-api-v1', safeDetail: 'Native API runtime is ready.' }),
    beginAuth: async (): Promise<AuthChallenge> => {
      const challenge = validateChallenge(await input.broker.issue(binding))
      return {
        kind: 'secret-input',
        provider: binding.provider,
        secretKind: 'api-key',
        safeInstructions:
          'В терминале хоста Aisy запусти: ' +
          `aisy brain credential set --code=${challenge.entryCode}`,
        secureEntryAvailable: true,
      }
    },
    validate: () => input.broker.validate(binding),
    revoke: () => input.broker.revoke(binding),
  })
}

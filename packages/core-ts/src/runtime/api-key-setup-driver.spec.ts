import { describe, expect, it, vi } from 'vitest'
import {
  ApiKeySetupDriverError,
  makeApiKeySetupDriver,
  type ApiCredentialBinding,
  type ApiCredentialBroker,
} from './api-key-setup-driver.js'

const BINDING: ApiCredentialBinding = {
  connectionId: 'openai-api',
  provider: 'openai',
  vaultKey: 'AISY_PROVIDER_OPENAI_KEY',
}

function broker(): ApiCredentialBroker {
  return {
    issue: vi.fn(async () => ({
      entryCode: 'PublicEntryCode_123456',
      expiresAt: '2026-07-27T12:00:00.000Z',
    })),
    validate: vi.fn(async () => ({ ok: true, safeDetail: 'ready' })),
    revoke: vi.fn(async () => ({ ok: true, safeDetail: 'revoked' })),
  }
}

describe('native API key setup driver', () => {
  it('exposes only a one-use local CLI instruction and delegates by exact binding', async () => {
    const controlPlane = broker()
    const driver = makeApiKeySetupDriver({ binding: BINDING, broker: controlPlane })

    await expect(driver.detect()).resolves.toEqual({ installed: true, version: 'native-api-v1' })
    await expect(driver.install()).resolves.toMatchObject({ installed: true })
    const challenge = await driver.beginAuth()
    expect(challenge).toEqual({
      kind: 'secret-input',
      provider: 'openai',
      secretKind: 'api-key',
      safeInstructions:
        'В терминале хоста Aisy запусти: aisy brain credential set --code=PublicEntryCode_123456',
      secureEntryAvailable: true,
    })
    expect(controlPlane.issue).toHaveBeenCalledWith(BINDING)
    await driver.validate()
    await driver.revoke()
    expect(controlPlane.validate).toHaveBeenCalledWith(BINDING)
    expect(controlPlane.revoke).toHaveBeenCalledWith(BINDING)
  })

  it('rejects invalid bindings before any broker action', () => {
    const controlPlane = broker()
    expect(() => makeApiKeySetupDriver({
      binding: { ...BINDING, vaultKey: '../secret' },
      broker: controlPlane,
    })).toThrow(ApiKeySetupDriverError)
    expect(controlPlane.issue).not.toHaveBeenCalled()
  })

  it.each([
    { entryCode: 'short', expiresAt: '2026-07-27T12:00:00.000Z' },
    { entryCode: 'PublicEntryCode_123456', expiresAt: 'not-a-date' },
  ])('fails closed on an unsafe broker challenge without exposing its fields', async (unsafe) => {
    const controlPlane = broker()
    controlPlane.issue = vi.fn(async () => unsafe)
    const driver = makeApiKeySetupDriver({ binding: BINDING, broker: controlPlane })

    await expect(driver.beginAuth()).rejects.toMatchObject({
      code: 'UNSAFE_API_CREDENTIAL_CHALLENGE',
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  inspectProviderBrokerDoctor,
  inspectProviderBrokerReady,
  type ProviderBrokerReadinessPort,
} from './provider-broker-readiness.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function port(changes: {
  socketUid?: number
  socketMode?: number
  readyUid?: number
  readyMode?: number
  missingSocket?: boolean
  missingReady?: boolean
  value?: unknown
} = {}): ProviderBrokerReadinessPort {
  const encoded = JSON.stringify(changes.value ?? {
    protocolVersion: 1,
    installationHash: HASH_A,
    releaseDigest: HASH_B,
    providers: ['openai', 'anthropic'],
  })
  return {
    facts(path) {
      if (path.endsWith('.sock')) return changes.missingSocket === true ? null : {
        uid: changes.socketUid ?? 0,
        mode: changes.socketMode ?? 0o660,
        size: 0,
        kind: 'socket',
      }
      return changes.missingReady === true ? null : {
        uid: changes.readyUid ?? 0,
        mode: changes.readyMode ?? 0o644,
        size: Buffer.byteLength(encoded),
        kind: 'file',
      }
    },
    read: () => encoded,
  }
}

describe('provider broker readiness', () => {
  it('accepts a root-owned exact attestation for every selected provider', () => {
    expect(inspectProviderBrokerReady({
      platform: 'linux',
      selectedProviders: ['openai', 'anthropic'],
      port: port(),
      expectedInstallationHash: HASH_A,
    })).toEqual({
      protocolVersion: 1,
      installationHash: HASH_A,
      releaseDigest: HASH_B,
      providers: ['openai', 'anthropic'],
    })
  })

  it.each([
    ['unsupported platform', { platform: 'darwin' as const, selectedProviders: ['openai'], port: port() }],
    ['custom provider', { platform: 'linux' as const, selectedProviders: ['openai-compat'], port: port() }],
    ['missing selected provider', { platform: 'linux' as const, selectedProviders: ['gemini'], port: port() }],
    ['foreign socket owner', { platform: 'linux' as const, selectedProviders: ['openai'], port: port({ socketUid: 501 }) }],
    ['writable attestation', { platform: 'linux' as const, selectedProviders: ['openai'], port: port({ readyMode: 0o666 }) }],
    ['unknown attested provider', {
      platform: 'linux' as const,
      selectedProviders: ['openai'],
      port: port({ value: {
        protocolVersion: 1,
        installationHash: HASH_A,
        releaseDigest: HASH_B,
        providers: ['openai', 'custom'],
      } }),
    }],
  ])('fails closed for %s', (_label, input) => {
    expect(inspectProviderBrokerReady(input)).toBeNull()
  })

  it('classifies read-only doctor states without provider I/O', () => {
    const base = {
      platform: 'linux' as const,
      selectedProviders: ['openai'],
      expectedInstallationHash: HASH_A,
    }
    expect(inspectProviderBrokerDoctor({ ...base, port: port() }).state).toBe('ready')
    expect(inspectProviderBrokerDoctor({
      ...base, port: port({ value: {
        protocolVersion: 1,
        installationHash: HASH_A,
        releaseDigest: HASH_B,
        providers: [],
      } }),
    }).state).toBe('unconfigured')
    expect(inspectProviderBrokerDoctor({
      ...base, selectedProviders: ['gemini'], port: port(),
    })).toEqual({ state: 'unavailable', readyProviders: ['openai', 'anthropic'] })
    expect(inspectProviderBrokerDoctor({
      ...base, port: port({ missingSocket: true, missingReady: true }),
    }).state).toBe('unconfigured')
    expect(inspectProviderBrokerDoctor({
      ...base, port: port({ missingSocket: true }),
    }).state).toBe('unavailable')
    expect(inspectProviderBrokerDoctor({
      ...base, port: port({ readyMode: 0o666 }),
    }).state).toBe('drifted')
    expect(inspectProviderBrokerDoctor({
      ...base, expectedInstallationHash: HASH_B, port: port(),
    }).state).toBe('drifted')
    expect(inspectProviderBrokerDoctor({
      ...base, selectedProviders: ['custom'], port: port(),
    }).state).toBe('incompatible')
    expect(inspectProviderBrokerDoctor({
      ...base, platform: 'darwin', port: port(),
    }).state).toBe('unsupported')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
const doctor = readFileSync(new URL('./doctor-runtime-probes.ts', import.meta.url), 'utf8')

describe('secure voice LIVE composition (ADR-0098)', () => {
  it('has no direct Deepgram credential resolver or HTTPS fallback', () => {
    expect(production).toContain('makeDeepgramProxyProvider')
    expect(production).toContain('executionSupervisorSession.voiceProxy')
    expect(production).toContain('makeTelegramVoiceMediaCapabilityIssuer')
    expect(production).toContain('mediaCapabilities: voiceMediaCapabilities')
    expect(production).not.toContain('makeDeepgramTranscriptionProvider')
    expect(production).not.toContain('makeVaultSecretResolver')
    expect(production).not.toContain('makeNodeDeepgramHttpsRequestPort')
  })

  it('keeps the root broker bridge in the supervisor and out of child env', () => {
    expect(production).toContain('openLinuxVoiceBrokerNativePort')
    expect(production).toContain("delete childEnv['AISY_VOICE_BROKER_ADDON_PATH']")
    expect(production).toContain("delete childEnv['AISY_VOICE_BROKER_BOOTSTRAP_SOCKET']")
    expect(production).toContain("delete childEnv['AISY_VOICE_BROKER_PID']")
    expect(production).toContain('voice: {')
  })

  it('parses the local setter before onboarding reads any configuration', () => {
    const command = production.indexOf("if (argv[0] === 'voice')")
    const onboarding = production.indexOf('// Non-run commands → onboarding CLI')
    expect(command).toBeGreaterThan(0)
    expect(command).toBeLessThan(onboarding)
    expect(production.slice(command, onboarding)).toContain('readVoiceCredentialFromTty')
  })

  it('uses proxy metadata in doctor without constructing a network provider', () => {
    expect(doctor).toContain('deepgramProxyProviderMetadata')
    expect(doctor).not.toContain('deepgramTranscriptionProviderMetadata')
  })
})

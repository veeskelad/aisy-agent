import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('native API secret production composition', () => {
  it('keeps legacy plaintext credentials outside live bootstrap and provider adapters', () => {
    const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')

    expect(production).toContain('nativeApiProviderIds(providersCfg, defaultSel)')
    expect(production).toContain('throw new Error(NATIVE_API_SECRET_PROXY_REQUIRED)')
    expect(production).not.toContain('credentials: makeProviderCredentialSetup({')
    expect(production).not.toMatch(/buildProvider\(\{[\s\S]{0,220}apiKey/)
  })
})

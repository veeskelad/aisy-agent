import { describe, expect, it } from 'vitest'
import type { CodexSubscriptionAuth } from './codex-auth.js'
import { makeCodexSubscriptionSetupDriver } from './codex-setup-driver.js'

describe('Codex subscription setup driver', () => {
  it('delegates only the official auth lifecycle and explicit installer port', async () => {
    const calls: string[] = []
    const auth: CodexSubscriptionAuth = {
      detect: async () => { calls.push('detect'); return { installed: false } },
      beginAuth: async () => {
        calls.push('beginAuth')
        return {
          kind: 'device-code',
          verificationUri: 'https://auth.example/activate',
          userCode: 'ABCD-1234',
        }
      },
      validate: async () => { calls.push('validate'); return { ok: true, safeDetail: 'ok' } },
      revoke: async () => { calls.push('revoke'); return { ok: true, safeDetail: 'ok' } },
    }
    const driver = makeCodexSubscriptionSetupDriver({
      auth,
      install: async () => { calls.push('install'); return { installed: true, safeDetail: 'ok' } },
    })

    expect(driver).toMatchObject({
      connectionId: 'codex-subscription',
      provider: 'openai',
      authMode: 'subscription',
      runtime: 'codex-app-server',
    })
    await driver.detect()
    await driver.install()
    await driver.beginAuth()
    await driver.validate()
    await driver.revoke()
    expect(calls).toEqual(['detect', 'install', 'beginAuth', 'validate', 'revoke'])
  })
})

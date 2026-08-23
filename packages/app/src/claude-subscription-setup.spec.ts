import { dirname } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  claudeCodeEnvironment,
  makeClaudeTokenSetup,
  type ClaudeSmokeTest,
} from './claude-subscription-setup.js'

const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40)

function harness(
  probe: Awaited<ReturnType<ClaudeSmokeTest>> = { ok: true, installed: true },
  initial: Record<string, string> = {},
) {
  const files = new Map<string, string>(Object.entries(initial))
  const probed: string[] = []
  const setup = makeClaudeTokenSetup({
    vaultPath: '/state/vault.json',
    providersPath: '/state/providers.json',
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? '',
    writePrivateFile: (path, content) => { files.set(path, content) },
    renameFile: (from, to) => {
      const content = files.get(from)
      if (content === undefined) throw new Error('missing temp')
      files.set(to, content)
      files.delete(from)
    },
    smokeTest: async (token) => { probed.push(token); return probe },
  })
  return { setup, files, probed }
}

describe('claude subscription token setup', () => {
  it('stores the token and makes the subscription the default brain', async () => {
    const h = harness({ ok: true, installed: true }, {
      '/state/vault.json': JSON.stringify({ AISY_TELEGRAM_BOT_TOKEN: 'keep' }),
    })

    await expect(h.setup.validateAndStore(` ${TOKEN} `)).resolves.toEqual({ ok: true })
    expect(h.probed).toEqual([TOKEN])
    expect(JSON.parse(h.files.get('/state/vault.json') ?? '{}')).toEqual({
      AISY_TELEGRAM_BOT_TOKEN: 'keep',
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    })
    expect(JSON.parse(h.files.get('/state/providers.json') ?? '{}').default).toEqual({
      provider: 'claude-subscription',
      model: 'default',
    })
  })

  it('refuses anything that is not a setup-token before touching the vault', async () => {
    const h = harness()

    await expect(h.setup.validateAndStore('   ')).resolves.toEqual({
      ok: false, errorCode: 'TOKEN_EMPTY',
    })
    // A plain Anthropic API key would bill the operator's API account instead
    // of running on the plan they just paid for.
    await expect(h.setup.validateAndStore('вот мой токен: ' + TOKEN)).resolves.toEqual({
      ok: false, errorCode: 'TOKEN_MALFORMED',
    })
    expect(h.probed).toEqual([])
    expect(h.files.size).toBe(0)
  })

  it('separates "CLI missing" from "subscription refused the token"', async () => {
    await expect(harness({ ok: false, installed: false }).setup.validateAndStore(TOKEN))
      .resolves.toEqual({ ok: false, errorCode: 'CLAUDE_NOT_INSTALLED' })
    await expect(harness({ ok: false, installed: true }).setup.validateAndStore(TOKEN))
      .resolves.toEqual({ ok: false, errorCode: 'TOKEN_REJECTED' })
  })

  it('never stores a token the smoke test rejected', async () => {
    const h = harness({ ok: false, installed: true })
    await h.setup.validateAndStore(TOKEN)
    expect(h.files.size).toBe(0)
  })

  it('fails closed on a corrupt vault', async () => {
    const h = harness({ ok: true, installed: true }, { '/state/vault.json': '{broken' })
    await expect(h.setup.validateAndStore(TOKEN)).resolves.toEqual({
      ok: false, errorCode: 'VAULT_CORRUPT',
    })
  })

  it('keeps an ambient API key from outranking the subscription', () => {
    const env = claudeCodeEnvironment({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-api-fixture',
      ANTHROPIC_AUTH_TOKEN: 'other',
    }, TOKEN)

    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined()
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(TOKEN)
    // `claude` is a `#!/usr/bin/env node` script and a service manager hands the
    // process a PATH without Node; the operator's entries survive after it.
    expect(env['PATH']?.split(':')[0]).toBe(dirname(process.execPath))
    expect(env['PATH']?.endsWith('/usr/bin')).toBe(true)
  })
})

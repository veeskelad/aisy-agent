import { describe, expect, it } from 'vitest'
import { makeProviderCredentialSetup } from './credential-setup.js'

function harness(
  status = 200,
  initial: Record<string, string> = {},
  body: unknown = { data: [] },
) {
  const files = new Map<string, string>(Object.entries(initial))
  const requests: Array<{ url: string; headers: Headers }> = []
  const operations: string[] = []
  const setup = makeProviderCredentialSetup({
    vaultPath: '/state/vault.json',
    providersPath: '/state/providers.json',
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? '',
    writePrivateFile: (path, content) => {
      operations.push('write:' + path)
      files.set(path, content)
    },
    renameFile: (from, to) => {
      operations.push(`rename:${from}->${to}`)
      const content = files.get(from)
      if (content === undefined) throw new Error('missing temp')
      files.set(to, content)
      files.delete(from)
    },
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  return { setup, files, requests, operations }
}

describe('provider API credential setup', () => {
  it('validates before atomically storing the canonical field', async () => {
    const h = harness(200, {
      '/state/vault.json': JSON.stringify({ EXISTING: 'keep' }),
      '/state/providers.json': JSON.stringify({ agents: { main: { budgetUsd: 1 } } }),
    })
    const result = await h.setup.validateAndStore('anthropic', 'fixture-value')
    expect(result).toEqual({ ok: true, model: 'claude-sonnet-5' })
    expect(h.requests[0]?.url).toBe('https://api.anthropic.com/v1/models')
    expect(h.requests[0]?.headers.get('x-api-key')).toBe('fixture-value')
    expect(JSON.parse(h.files.get('/state/vault.json') ?? '{}')).toEqual({
      EXISTING: 'keep',
      AISY_PROVIDER_ANTHROPIC_KEY: 'fixture-value',
    })
    expect(JSON.parse(h.files.get('/state/providers.json') ?? '{}')).toEqual({
      agents: { main: { budgetUsd: 1 } },
      default: { provider: 'anthropic', model: 'claude-sonnet-5' },
    })
    expect(h.operations).toEqual([
      'write:/state/vault.json.tmp',
      'rename:/state/vault.json.tmp->/state/vault.json',
      'write:/state/providers.json.tmp',
      'rename:/state/providers.json.tmp->/state/providers.json',
    ])
  })

  it('picks the best OpenRouter model the account can actually reach', async () => {
    const h = harness(200, {}, {
      data: [{ id: 'deepseek/deepseek-chat' }, { id: 'openai/gpt-4o' }],
    })
    await expect(h.setup.validateAndStore('openrouter', 'fixture-value')).resolves.toEqual({
      ok: true,
      model: 'openai/gpt-4o',
    })
    expect(h.requests[0]?.url).toBe('https://openrouter.ai/api/v1/models')
    expect(h.requests[0]?.headers.get('authorization')).toBe('Bearer fixture-value')
    expect(JSON.parse(h.files.get('/state/providers.json') ?? '{}').default).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-4o',
    })
  })

  it('falls back to auto routing when no preferred id is listed', async () => {
    const h = harness(200, {}, { data: [{ id: 'some/unknown-model' }] })
    await expect(h.setup.validateAndStore('openrouter', 'fixture-value')).resolves.toEqual({
      ok: true,
      model: 'openrouter/auto',
    })
  })

  it('never persists a rejected credential or returns it in the error', async () => {
    const h = harness(401)
    const result = await h.setup.validateAndStore('openai', 'fixture-rejected')
    expect(result).toEqual({ ok: false, errorCode: 'AUTH_REJECTED' })
    expect(JSON.stringify(result)).not.toContain('fixture-rejected')
    expect(h.operations).toEqual([])
  })

  it('fails closed on unavailable validation and malformed durable files', async () => {
    const unavailable = makeProviderCredentialSetup({
      vaultPath: '/v',
      providersPath: '/p',
      exists: () => false,
      readFile: () => '',
      writePrivateFile: () => {},
      renameFile: () => {},
      fetchImpl: async () => { throw new Error('network detail') },
    })
    await expect(unavailable.validateAndStore('openai', 'fixture-value')).resolves.toEqual({
      ok: false,
      errorCode: 'VALIDATION_UNAVAILABLE',
    })

    const malformed = harness(200, { '/state/vault.json': '{broken' })
    await expect(malformed.setup.validateAndStore('openai', 'fixture-value')).resolves.toEqual({
      ok: false,
      errorCode: 'VAULT_CORRUPT',
    })
    expect(malformed.operations).toEqual([])
  })

  it('rejects empty and unsupported input without a network request', async () => {
    const h = harness()
    await expect(h.setup.validateAndStore('openai', '   ')).resolves.toEqual({
      ok: false,
      errorCode: 'CREDENTIAL_EMPTY',
    })
    await expect(h.setup.validateAndStore('custom', 'fixture-value')).resolves.toEqual({
      ok: false,
      errorCode: 'UNSUPPORTED_PROVIDER',
    })
    expect(h.requests).toEqual([])
  })
})

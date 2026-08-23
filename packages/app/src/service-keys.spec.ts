import { describe, expect, it } from 'vitest'

import { makeServiceKeyStore, SERVICE_KEY_CATALOG } from './service-keys.js'

function harness(initial: Record<string, string> = {}, probeStatus: number | 'offline' = 200) {
  const files = new Map<string, string>()
  if (Object.keys(initial).length > 0) files.set('/state/vault.json', JSON.stringify(initial))
  const probes: string[] = []
  const store = makeServiceKeyStore({
    vaultPath: '/state/vault.json',
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? '',
    writePrivateFile: (path, content) => { files.set(path, content) },
    renameFile: (from, to) => {
      const content = files.get(from)
      if (content === undefined) throw new Error('missing temp')
      files.set(to, content)
      files.delete(from)
    },
    fetchImpl: async (input) => {
      probes.push(String(input))
      if (probeStatus === 'offline') throw new Error('network unreachable')
      return new Response('', { status: probeStatus })
    },
  })
  const vault = (): Record<string, string> =>
    JSON.parse(files.get('/state/vault.json') ?? '{}') as Record<string, string>
  return { store, vault, probes }
}

describe('service key store', () => {
  it('verifies with the vendor, then stores under the canonical env name', async () => {
    const h = harness({ AISY_TELEGRAM_BOT_TOKEN: 'keep' })

    await expect(h.store.store('deepgram', '  dg-fixture-0123456789abcdef  ')).resolves.toEqual({
      ok: true, envKey: 'AISY_DEEPGRAM_KEY', verified: true,
    })
    expect(h.probes).toEqual(['https://api.deepgram.com/v1/projects'])
    expect(h.vault()).toEqual({
      AISY_TELEGRAM_BOT_TOKEN: 'keep',
      AISY_DEEPGRAM_KEY: 'dg-fixture-0123456789abcdef',
    })
    expect(h.store.connected()).toEqual(['deepgram'])
  })

  it('refuses an ordinary message instead of storing it as a key', async () => {
    const h = harness()

    // The operator taps Deepgram, gets distracted, and writes to the agent.
    await expect(h.store.store('deepgram', 'напомни про встречу в четверг'))
      .resolves.toEqual({ ok: false, errorCode: 'NOT_A_KEY' })
    await expect(h.store.store('deepgram', 'short')).resolves.toEqual({
      ok: false, errorCode: 'NOT_A_KEY',
    })
    expect(h.probes).toEqual([])
    expect(h.vault()).toEqual({})
  })

  it('catches a key pasted into the wrong service', async () => {
    const h = harness()

    await expect(h.store.store('openrouter', 'ghp_0123456789abcdefghij')).resolves.toEqual({
      ok: false, errorCode: 'WRONG_PREFIX',
    })
    expect(h.probes).toEqual([])
  })

  it('never stores a key the vendor rejected', async () => {
    const h = harness({}, 401)

    await expect(h.store.store('deepgram', 'dg-wrong-0123456789abcdef')).resolves.toEqual({
      ok: false, errorCode: 'KEY_REJECTED',
    })
    expect(h.vault()).toEqual({})
  })

  it('stores an unverifiable key rather than locking out a blocked host', async () => {
    const offline = harness({}, 'offline')
    await expect(offline.store.store('deepgram', 'dg-fixture-0123456789abcdef'))
      .resolves.toEqual({ ok: true, envKey: 'AISY_DEEPGRAM_KEY', verified: false })

    // No verify endpoint in the catalogue is the same situation: shape only.
    const noProbe = harness()
    await expect(noProbe.store.store('serper', 'srp-0123456789abcdef'))
      .resolves.toEqual({ ok: true, envKey: 'AISY_SERPER_KEY', verified: false })
    expect(noProbe.probes).toEqual([])
  })

  it('refuses to overwrite the keys the runtime itself depends on', () => {
    const h = harness({ AISY_TELEGRAM_BOT_TOKEN: 'keep' })

    expect(h.store.storeCustom('AISY_TELEGRAM_BOT_TOKEN=stolen-0123456789abcdef')).toEqual({
      ok: false, errorCode: 'PROTECTED_KEY',
    })
    expect(h.store.storeCustom('CLAUDE_CODE_OAUTH_TOKEN=stolen-0123456789abcdef')).toEqual({
      ok: false, errorCode: 'PROTECTED_KEY',
    })
    expect(h.vault()['AISY_TELEGRAM_BOT_TOKEN']).toBe('keep')
  })

  it('takes a custom NAME=value and rejects a malformed one', () => {
    const h = harness()

    expect(h.store.storeCustom('MY_CRM_TOKEN = crm-fixture-0123456789')).toEqual({
      ok: true, envKey: 'MY_CRM_TOKEN', verified: false,
    })
    expect(h.vault()['MY_CRM_TOKEN']).toBe('crm-fixture-0123456789')
    expect(h.store.storeCustom('просто ключ')).toEqual({
      ok: false, errorCode: 'INVALID_KEY_NAME',
    })
    expect(h.store.storeCustom('my-crm=x')).toEqual({
      ok: false, errorCode: 'INVALID_KEY_NAME',
    })
    expect(h.store.storeCustom('MY_CRM_TOKEN=')).toEqual({
      ok: false, errorCode: 'VALUE_EMPTY',
    })
    expect(h.store.storeCustom('MY_CRM_TOKEN=это не ключ')).toEqual({
      ok: false, errorCode: 'NOT_A_KEY',
    })
  })

  it('fails closed on a corrupt vault instead of replacing it', async () => {
    const files = new Map([['/state/vault.json', '{broken']])
    const store = makeServiceKeyStore({
      vaultPath: '/state/vault.json',
      exists: (path) => files.has(path),
      readFile: (path) => files.get(path) ?? '',
      writePrivateFile: (path, content) => { files.set(path, content) },
      renameFile: () => {},
      // A corrupt vault must be refused before the key is sent anywhere.
      fetchImpl: async () => { throw new Error('must not reach the network') },
    })

    await expect(store.store('deepgram', 'dg-fixture-0123456789abcdef'))
      .resolves.toEqual({ ok: false, errorCode: 'VAULT_CORRUPT' })
    expect(store.connected()).toEqual([])
    expect(files.get('/state/vault.json')).toBe('{broken')
  })

  it('keeps every catalogue entry addressable and distinct', () => {
    const ids = SERVICE_KEY_CATALOG.map((entry) => entry.id)
    const envKeys = SERVICE_KEY_CATALOG.map((entry) => entry.envKey)

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(envKeys).size).toBe(envKeys.length)
    for (const entry of SERVICE_KEY_CATALOG) {
      expect(entry.source.length).toBeGreaterThan(0)
      expect(entry.purpose.length).toBeGreaterThan(0)
    }
  })
})

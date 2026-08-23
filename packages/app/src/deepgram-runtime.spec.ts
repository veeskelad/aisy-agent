import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEEPGRAM_VAULT_KEY,
  makeNodeDeepgramHttpsRequestPort,
  makeNodeDeepgramProxySpendAuthority,
  makeNodeDeepgramSpendAuthority,
  makeVaultSecretResolver,
} from './deepgram-runtime.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-voice-'))
  roots.push(value)
  return value
}

const REQUEST = {
  method: 'POST' as const,
  url: 'https://api.deepgram.com/v1/listen?model=nova-3',
  headers: { authorization: 'Token secret' },
  body: new Uint8Array([1, 2, 3]),
  maxResponseBytes: 64,
  redirect: 'error' as const,
  signal: new AbortController().signal,
}

describe('Deepgram HTTPS port', () => {
  it('sends to the pinned endpoint and returns the collected body', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response('{"ok":true}', { status: 200 }))
    const port = makeNodeDeepgramHttpsRequestPort({
      endpointHost: 'api.deepgram.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const response = await port.request(REQUEST)

    expect(response.status).toBe(200)
    expect(new TextDecoder().decode(response.body!)).toBe('{"ok":true}')
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: 'error', method: 'POST' })
  })

  it('refuses a URL that is not the configured endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }))
    const port = makeNodeDeepgramHttpsRequestPort({
      endpointHost: 'api.eu.deepgram.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    // Audio leaves the host here; the destination is not something to infer.
    await expect(port.request(REQUEST)).rejects.toThrow('DEEPGRAM_ENDPOINT_MISMATCH')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stops reading a response that exceeds the bound', async () => {
    const port = makeNodeDeepgramHttpsRequestPort({
      endpointHost: 'api.deepgram.com',
      fetchImpl: (async () => new Response('x'.repeat(1024))) as unknown as typeof fetch,
    })

    await expect(port.request(REQUEST)).rejects.toThrow('DEEPGRAM_RESPONSE_TOO_LARGE')
  })
})

describe('voice spend authority', () => {
  const signal = new AbortController().signal
  const reservation = (maximumBillableDurationMs: number) => ({
    providerId: 'deepgram-cloud' as const,
    requestHash: 'a'.repeat(64),
    maximumBillableDurationMs,
    signal,
  })

  function authority(path: string, dailyLimitMs = 10_000, day = '2026-08-07') {
    return makeNodeDeepgramSpendAuthority({
      path, dailyLimitMs, nowIso: () => `${day}T10:00:00.000Z`,
    })
  }

  it('charges what was actually used and frees the rest', async () => {
    const path = join(root(), 'voice-spend.json')
    const spend = authority(path)

    const handle = await spend.reserve(reservation(6_000))
    await handle!.settle({ kind: 'settled', billableDurationMs: 2_000 })

    const state = JSON.parse(readFileSync(path, 'utf8')) as { spentMs: number; open: object }
    expect(state.spentMs).toBe(2_000)
    expect(state.open).toEqual({})
    // The freed reservation is available again within the same day.
    expect(await spend.reserve(reservation(8_000))).not.toBeNull()
  })

  it('refuses once the day is spent instead of billing past the cap', async () => {
    const path = join(root(), 'voice-spend.json')
    const spend = authority(path)
    await (await spend.reserve(reservation(9_000)))!.settle({
      kind: 'settled', billableDurationMs: 9_000,
    })

    expect(await spend.reserve(reservation(2_000))).toBeNull()
    expect(await spend.reserve(reservation(1_000))).not.toBeNull()
  })

  it('charges the full reservation when the outcome is unknown', async () => {
    const path = join(root(), 'voice-spend.json')
    const spend = authority(path)

    // The request went out and the answer never came back: an uncharged
    // dispatch is exactly how a cap gets walked past.
    await (await spend.reserve(reservation(5_000)))!.settle({ kind: 'ambiguous' })

    expect((JSON.parse(readFileSync(path, 'utf8')) as { spentMs: number }).spentMs).toBe(5_000)
  })

  it('releases without charge when nothing was dispatched', async () => {
    const path = join(root(), 'voice-spend.json')
    const spend = authority(path)

    await (await spend.reserve(reservation(5_000)))!.settle({ kind: 'released' })

    expect((JSON.parse(readFileSync(path, 'utf8')) as { spentMs: number }).spentMs).toBe(0)
  })

  it('keeps an unsettled reservation held across a restart', async () => {
    const path = join(root(), 'voice-spend.json')
    await authority(path).reserve(reservation(9_000))

    // A crash between dispatch and settle leaves the money committed until the
    // day rolls over — the alternative is a loop that spends without limit.
    expect(await authority(path).reserve(reservation(2_000))).toBeNull()
  })

  it('starts a new day with a clean cap', async () => {
    const path = join(root(), 'voice-spend.json')
    await (await authority(path).reserve(reservation(9_000)))!.settle({
      kind: 'settled', billableDurationMs: 9_000,
    })

    expect(await authority(path, 10_000, '2026-08-08').reserve(reservation(9_000))).not.toBeNull()
  })

  it('settles once, however many times it is told to', async () => {
    const path = join(root(), 'voice-spend.json')
    const spend = authority(path)
    const handle = await spend.reserve(reservation(5_000))

    await handle!.settle({ kind: 'settled', billableDurationMs: 3_000 })
    await handle!.settle({ kind: 'ambiguous' })

    expect((JSON.parse(readFileSync(path, 'utf8')) as { spentMs: number }).spentMs).toBe(3_000)
  })

  it('treats a corrupt ledger as spent, not as unlimited', async () => {
    const path = join(root(), 'voice-spend.json')
    writeFileSync(path, '{broken')

    const handle = await authority(path).reserve(reservation(5_000))

    expect(handle).not.toBeNull()
    expect((JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number }).schemaVersion).toBe(1)
  })
})

describe('voice proxy spend authority', () => {
  const signal = new AbortController().signal
  const request = {
    providerId: 'deepgram-cloud' as const,
    requestHash: 'b'.repeat(64),
    maximumBillableDurationMs: 5_000,
    signal,
  }

  function proxy(path: string) {
    return makeNodeDeepgramProxySpendAuthority({
      path, dailyLimitMs: 10_000, nowIso: () => '2026-08-14T00:00:00.000Z',
    })
  }

  it('recovers the same opaque hold after restart and settles it once', async () => {
    const path = join(root(), 'voice-proxy-spend.json')
    const first = await proxy(path).reserve(request)
    expect(first?.recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const recovered = await proxy(path).recover(first!.recoveryKey)
    expect(recovered?.recoveryKey).toBe(first!.recoveryKey)
    await recovered!.settle({ kind: 'settled', billableDurationMs: 1_250 })
    await first!.settle({ kind: 'ambiguous' })

    const state = JSON.parse(readFileSync(path, 'utf8')) as { spentMs: number; open: object }
    expect(state).toMatchObject({ spentMs: 1_250, open: {} })
  })

  it('fails closed on corrupt state and never overwrites it with a fresh cap', async () => {
    const path = join(root(), 'voice-proxy-spend.json')
    writeFileSync(path, '{broken')

    await expect(proxy(path).reserve(request)).resolves.toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })
})

describe('vault secret resolver', () => {
  it('maps the vendor name to the name the vault stores', async () => {
    const vaultPath = join(root(), 'vault.json')
    writeFileSync(vaultPath, JSON.stringify({ [DEEPGRAM_VAULT_KEY]: 'dg-key-value' }))
    const resolve = makeVaultSecretResolver({
      vaultPath, mapping: { DEEPGRAM_API_KEY: DEEPGRAM_VAULT_KEY },
    })

    await expect(resolve('DEEPGRAM_API_KEY')).resolves.toBe('dg-key-value')
    await expect(resolve('OTHER_KEY')).resolves.toBeNull()
  })

  it('picks up a key added after the process started', async () => {
    const vaultPath = join(root(), 'vault.json')
    const resolve = makeVaultSecretResolver({
      vaultPath, mapping: { DEEPGRAM_API_KEY: DEEPGRAM_VAULT_KEY },
    })
    await expect(resolve('DEEPGRAM_API_KEY')).resolves.toBeNull()

    // The operator adds the key from the phone; voice must work without a restart.
    writeFileSync(vaultPath, JSON.stringify({ [DEEPGRAM_VAULT_KEY]: 'dg-added-later' }))

    await expect(resolve('DEEPGRAM_API_KEY')).resolves.toBe('dg-added-later')
  })

  it('answers null for a corrupt vault instead of throwing into the provider', async () => {
    const vaultPath = join(root(), 'vault.json')
    writeFileSync(vaultPath, '{broken')
    const resolve = makeVaultSecretResolver({
      vaultPath, mapping: { DEEPGRAM_API_KEY: DEEPGRAM_VAULT_KEY },
    })

    await expect(resolve('DEEPGRAM_API_KEY')).resolves.toBeNull()
  })
})

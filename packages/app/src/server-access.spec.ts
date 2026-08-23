import { describe, expect, it, vi } from 'vitest'

import {
  checkPublicKey,
  makeServerAccess,
  publicKeyFingerprint,
  type ServerAccessConfig,
} from './server-access.js'

const KEY = `ssh-ed25519 ${Buffer.from('a'.repeat(64)).toString('base64')} operator@phone`

const CONFIG: ServerAccessConfig = {
  operations: {
    'open-ssh': { argv: ['sudo', 'ufw', 'allow', '22'] },
    'close-ssh': { argv: ['sudo', 'ufw', 'deny', '22'] },
    'add-key': { argv: ['/usr/local/bin/aisy-add-key', '{key}'] },
  },
  ttlSeconds: 3600,
}

function access(over: {
  config?: ServerAccessConfig | null
  now?: () => string
  ok?: boolean
} = {}) {
  const calls: string[][] = []
  const audit: Array<{ event: string; payload: Record<string, unknown> }> = []
  const value = makeServerAccess({
    config: over.config === undefined ? CONFIG : over.config,
    runner: {
      run: async (argv) => {
        calls.push([...argv])
        return { ok: over.ok ?? true, output: 'готово' }
      },
    },
    nowIso: over.now ?? (() => '2026-07-29T12:00:00.000Z'),
    audit: (event, payload) => audit.push({ event, payload }),
  })
  return { value, calls, audit }
}

const approve = async () => true
const reject = async () => false

describe('server access control (ADR-0086)', () => {
  it('runs only the argv the operator configured', async () => {
    const h = access()

    const result = await h.value.request({ operation: 'open-ssh', provenance: 'operator', approve })

    expect(h.calls).toEqual([['sudo', 'ufw', 'allow', '22']])
    expect(result).toMatchObject({ operation: 'open-ssh', expiresAt: '2026-07-29T13:00:00.000Z' })
  })

  it('refuses an operation nobody described', async () => {
    const h = access()

    expect(await h.value.request({ operation: 'tunnel', provenance: 'operator', approve }))
      .toBe('not-configured')
    expect(h.calls).toEqual([])
  })

  it('refuses everything when access is not configured at all', async () => {
    const h = access({ config: null })

    expect(h.value.available()).toEqual([])
    expect(await h.value.request({ operation: 'open-ssh', provenance: 'operator', approve }))
      .toBe('not-configured')
  })

  it('refuses an untrusted caller before an approval is ever shown', async () => {
    const h = access()
    const shown = vi.fn(approve)

    const result = await h.value.request({
      operation: 'open-ssh',
      provenance: 'untrusted',
      approve: shown,
    })

    expect(result).toBe('untrusted-caller')
    expect(shown).not.toHaveBeenCalled()
    expect(h.calls).toEqual([])
  })

  it('does nothing when the operator declines', async () => {
    const h = access()

    expect(await h.value.request({ operation: 'open-ssh', provenance: 'operator', approve: reject }))
      .toBe('not-approved')
    expect(h.calls).toEqual([])
    expect(h.audit.at(-1)?.event).toBe('server.access_refused')
  })

  it('substitutes the key into the configured argv and audits only the fingerprint', async () => {
    const h = access()

    const result = await h.value.request({
      operation: 'add-key',
      provenance: 'operator',
      approve,
      publicKey: KEY,
    })

    expect(h.calls[0]).toEqual(['/usr/local/bin/aisy-add-key', KEY])
    expect(result).toMatchObject({ fingerprint: publicKeyFingerprint(KEY) })
    const granted = h.audit.find((entry) => entry.event === 'server.access_granted')
    expect(JSON.stringify(granted)).not.toContain(KEY.split(' ')[1])
    expect(granted?.payload['fingerprint']).toBe(publicKeyFingerprint(KEY))
  })

  it('refuses a private key without echoing a byte of it', async () => {
    const h = access()
    const secret = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecret\n-----END OPENSSH PRIVATE KEY-----'

    const result = await h.value.request({
      operation: 'add-key',
      provenance: 'operator',
      approve,
      publicKey: secret,
    })

    expect(result).toBe('private-key-refused')
    expect(JSON.stringify(h.audit)).not.toContain('AAAAsecret')
    expect(h.calls).toEqual([])
  })

  it('refuses a key that is not a key', async () => {
    expect(checkPublicKey('ssh-ed25519 не-base64 comment')).toBe('bad-key')
    expect(checkPublicKey('rm -rf /')).toBe('bad-key')
    expect(checkPublicKey(`ssh-ed25519 ${Buffer.from('a'.repeat(64)).toString('base64')}\nssh-rsa AAAA x`))
      .toBe('bad-key')
    expect(checkPublicKey(KEY)).toBe(true)
  })

  it('closes an expired door by itself, with the configured closer', async () => {
    let now = '2026-07-29T12:00:00.000Z'
    const h = access({ now: () => now })
    await h.value.request({ operation: 'open-ssh', provenance: 'operator', approve })

    expect(await h.value.expire()).toEqual([])

    now = '2026-07-29T13:30:00.000Z'
    expect(await h.value.expire()).toEqual(['open-ssh'])
    expect(h.calls.at(-1)).toEqual(['sudo', 'ufw', 'deny', '22'])
    // …and only once.
    expect(await h.value.expire()).toEqual([])
  })

  it('reports a failed command instead of claiming the door opened', async () => {
    const h = access({ ok: false })

    expect(await h.value.request({ operation: 'open-ssh', provenance: 'operator', approve }))
      .toBe('command-failed')
    expect(h.audit.at(-1)?.event).toBe('server.access_failed')
    // A door that never opened must not be scheduled to close.
    expect(await h.value.expire()).toEqual([])
  })
})

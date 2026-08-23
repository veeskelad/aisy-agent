import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  makeApiCredentialIngress,
  type ApiCredentialCommittingRecord,
  type ApiCredentialIngressRecord,
  type ApiCredentialIngressStore,
  type ApiCredentialProviderValidator,
  type ApiCredentialVaultTransactions,
} from './api-credential-ingress.js'
import type { BrainValidationResult } from '../onboarding/brain-connections.js'
import type { ApiCredentialBinding } from './api-key-setup-driver.js'

const BINDING: ApiCredentialBinding = {
  connectionId: 'openai-api',
  provider: 'openai',
  vaultKey: 'AISY_PROVIDER_OPENAI_KEY',
}
const ENTRY_CODE = 'PublicEntryCode_123456'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function setup() {
  let record: ApiCredentialIngressRecord | null = null
  let markReadyFailures = 0
  let markFailedFailures = 0
  const store: ApiCredentialIngressStore = {
    async issue(value) {
      record = clone(value)
    },
    async claim(codeHash, nowIso) {
      if (record?.status !== 'issued' || record.codeHash !== codeHash ||
        Date.parse(record.expiresAt) <= Date.parse(nowIso)) return null
      const { codeHash: _removed, ...base } = record
      void _removed
      record = { ...base, status: 'committing', updatedAt: nowIso }
      return clone(record as ApiCredentialCommittingRecord)
    },
    async current(binding) {
      return record !== null && record.connectionId === binding.connectionId &&
        record.provider === binding.provider && record.vaultKey === binding.vaultKey
        ? clone(record)
        : null
    },
    async markReady(id, nowIso) {
      if (markReadyFailures > 0) {
        markReadyFailures--
        throw new Error('injected state failure')
      }
      if (record?.id !== id || record.status !== 'committing') return false
      record = { ...record, status: 'ready', updatedAt: nowIso }
      return true
    },
    async markFailed(id, errorCode, nowIso) {
      if (markFailedFailures > 0) {
        markFailedFailures--
        throw new Error('injected failed-publication failure')
      }
      if (record?.id !== id || record.status !== 'committing') return false
      record = { ...record, status: 'failed', lastErrorCode: errorCode, updatedAt: nowIso }
      return true
    },
    async markRevoked(binding, nowIso) {
      if (record === null || record.connectionId !== binding.connectionId ||
        record.provider !== binding.provider || record.vaultKey !== binding.vaultKey) return false
      record = { ...record, status: 'revoked', updatedAt: nowIso }
      return true
    },
  }

  const staged = new Map<string, Uint8Array>()
  const active = new Map<string, { transactionId: string; value: Uint8Array }>()
  let discardFailures = 0
  const stageKey = (vaultKey: string, transactionId: string) => `${vaultKey}\0${transactionId}`
  const vault: ApiCredentialVaultTransactions = {
    async stage(vaultKey, transactionId, secret) {
      staged.set(stageKey(vaultKey, transactionId), secret.slice())
    },
    async hasStaged(vaultKey, transactionId) {
      return staged.has(stageKey(vaultKey, transactionId))
    },
    async activate(vaultKey, transactionId) {
      const key = stageKey(vaultKey, transactionId)
      const value = staged.get(key)
      if (!value) throw new Error('staged secret missing')
      active.set(vaultKey, { transactionId, value })
      staged.delete(key)
    },
    async discard(vaultKey, transactionId) {
      if (discardFailures > 0) {
        discardFailures--
        throw new Error('injected discard failure')
      }
      staged.delete(stageKey(vaultKey, transactionId))
    },
    async activeTransactionId(vaultKey) {
      return active.get(vaultKey)?.transactionId ?? null
    },
    async deleteActive(vaultKey) {
      active.delete(vaultKey)
    },
  }
  let stagedValidation: BrainValidationResult = { ok: true, safeDetail: 'provider accepted' }
  const validator: ApiCredentialProviderValidator = {
    validateStaged: vi.fn(async () => ({ ...stagedValidation })),
    validateActive: vi.fn(async () => ({ ok: true, safeDetail: 'healthy' })),
  }
  let nowMs = Date.parse('2026-07-27T10:00:00.000Z')
  let id = 0
  const make = () => makeApiCredentialIngress({
    store,
    vault,
    validator,
    nowMs: () => nowMs,
    newId: () => `credential-${++id}`,
    newEntryCode: () => ENTRY_CODE,
  })
  return {
    store,
    vault,
    validator,
    staged,
    active,
    make,
    record: () => record,
    failMarkReadyOnce: () => { markReadyFailures++ },
    failMarkFailedOnce: () => { markFailedFailures++ },
    failDiscardOnce: () => { discardFailures++ },
    rejectStaged: (errorCode?: string) => {
      stagedValidation = errorCode === undefined
        ? { ok: false, safeDetail: 'raw provider detail must be dropped' }
        : { ok: false, safeDetail: 'raw provider detail must be dropped', errorCode }
    },
    advance: (ms: number) => { nowMs += ms },
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

describe('API credential ingress control plane', () => {
  it('stores only a hash of the public one-use entry code', async () => {
    const h = setup()
    const challenge = await h.make().issue(BINDING)

    expect(challenge).toEqual({
      entryCode: ENTRY_CODE,
      expiresAt: '2026-07-27T10:10:00.000Z',
    })
    const persisted = JSON.stringify(h.record())
    expect(persisted).not.toContain(ENTRY_CODE)
    expect(h.record()).toMatchObject({
      status: 'issued',
      codeHash: createHash('sha256').update(ENTRY_CODE).digest('hex'),
    })
  })

  it('stages, validates and atomically activates a secret, then blocks replay', async () => {
    const h = setup()
    const ingress = h.make()
    await ingress.issue(BINDING)
    const secret = bytes('provider-key-test-value')

    await expect(ingress.submit(ENTRY_CODE, secret)).resolves.toEqual({
      ok: true,
      safeDetail: 'API credential is validated and active.',
    })
    expect([...secret]).toEqual(new Array(secret.length).fill(0))
    expect(h.record()).toMatchObject({ status: 'ready', id: 'credential-1' })
    expect(h.active.get(BINDING.vaultKey)?.transactionId).toBe('credential-1')
    expect(JSON.stringify(h.record())).not.toContain('provider-key-test-value')

    const replay = bytes('different-provider-key')
    await expect(ingress.submit(ENTRY_CODE, replay)).resolves.toMatchObject({
      ok: false,
      errorCode: 'API_CREDENTIAL_CHALLENGE_REJECTED',
    })
    expect([...replay]).toEqual(new Array(replay.length).fill(0))
    expect(h.active.get(BINDING.vaultKey)?.transactionId).toBe('credential-1')
  })

  it('discards rejected staged material and stores only an allowlisted error code', async () => {
    const h = setup()
    h.rejectStaged('raw-provider-error')
    const ingress = h.make()
    await ingress.issue(BINDING)
    const secret = bytes('provider-key-test-value')

    await expect(ingress.submit(ENTRY_CODE, secret)).resolves.toEqual({
      ok: false,
      safeDetail: 'API credential was not activated.',
      errorCode: 'API_CREDENTIAL_REJECTED',
    })
    expect(h.staged.size).toBe(0)
    expect(h.active.size).toBe(0)
    expect(h.record()).toMatchObject({
      status: 'failed', lastErrorCode: 'API_CREDENTIAL_REJECTED',
    })
    expect(JSON.stringify(h.record())).not.toContain('raw provider detail')
  })

  it('recovers after activation succeeded but durable ready publication failed', async () => {
    const h = setup()
    const first = h.make()
    await first.issue(BINDING)
    h.failMarkReadyOnce()

    await expect(first.submit(ENTRY_CODE, bytes('provider-key-test-value'))).resolves.toMatchObject({
      ok: false, errorCode: 'API_CREDENTIAL_STATE_FAILED',
    })
    expect(h.record()).toMatchObject({ status: 'committing' })
    expect(h.active.get(BINDING.vaultKey)?.transactionId).toBe('credential-1')

    await expect(h.make().recover(BINDING)).resolves.toEqual({
      ok: true,
      safeDetail: 'API credential activation was recovered.',
    })
    expect(h.record()).toMatchObject({ status: 'ready' })
  })

  it('recovers a staged transaction after restart without accepting the code twice', async () => {
    const h = setup()
    const first = h.make()
    const challenge = await first.issue(BINDING)
    const claimed = await h.store.claim(
      createHash('sha256').update(challenge.entryCode).digest('hex'),
      '2026-07-27T10:00:01.000Z',
    )
    if (claimed === null) throw new Error('expected claim')
    await h.vault.stage(claimed.vaultKey, claimed.id, bytes('provider-key-test-value'))

    await expect(h.make().recover(BINDING)).resolves.toMatchObject({ ok: true })
    expect(h.record()).toMatchObject({ status: 'ready' })
    expect(h.staged.size).toBe(0)
    expect(h.active.get(BINDING.vaultKey)?.transactionId).toBe('credential-1')
  })

  it('discards a prior committing stage before issuing a replacement challenge', async () => {
    const h = setup()
    const ingress = h.make()
    const challenge = await ingress.issue(BINDING)
    const claimed = await h.store.claim(
      createHash('sha256').update(challenge.entryCode).digest('hex'),
      '2026-07-27T10:00:01.000Z',
    )
    if (claimed === null) throw new Error('expected claim')
    await h.vault.stage(claimed.vaultKey, claimed.id, bytes('provider-key-test-value'))
    expect(h.staged.size).toBe(1)

    await ingress.issue(BINDING)
    expect(h.staged.size).toBe(0)
    expect(h.record()).toMatchObject({ id: 'credential-2', status: 'issued' })
  })

  it('keeps rollback authority durable until staged cleanup succeeds', async () => {
    const h = setup()
    h.rejectStaged('API_CREDENTIAL_REJECTED')
    h.failDiscardOnce()
    const ingress = h.make()
    await ingress.issue(BINDING)

    await expect(ingress.submit(ENTRY_CODE, bytes('provider-key-test-value'))).resolves
      .toMatchObject({ ok: false, errorCode: 'API_CREDENTIAL_ROLLBACK_FAILED' })
    expect(h.record()).toMatchObject({ status: 'committing' })
    expect(h.staged.size).toBe(1)

    await expect(h.make().recover(BINDING)).resolves
      .toMatchObject({ ok: false, errorCode: 'API_CREDENTIAL_REJECTED' })
    expect(h.record()).toMatchObject({ status: 'failed' })
    expect(h.staged.size).toBe(0)
  })

  it('recovers after staged cleanup succeeds but failed-state publication throws', async () => {
    const h = setup()
    h.rejectStaged('API_CREDENTIAL_REJECTED')
    h.failMarkFailedOnce()
    const ingress = h.make()
    await ingress.issue(BINDING)

    await expect(ingress.submit(ENTRY_CODE, bytes('provider-key-test-value'))).resolves
      .toMatchObject({ ok: false, errorCode: 'API_CREDENTIAL_STATE_FAILED' })
    expect(h.record()).toMatchObject({ status: 'committing' })
    expect(h.staged.size).toBe(0)

    await expect(h.make().recover(BINDING)).resolves
      .toMatchObject({ ok: false, errorCode: 'API_CREDENTIAL_STAGE_MISSING' })
    expect(h.record()).toMatchObject({ status: 'failed' })
  })

  it('revoke removes a pending staged transaction before publishing metadata', async () => {
    const h = setup()
    const ingress = h.make()
    const challenge = await ingress.issue(BINDING)
    const claimed = await h.store.claim(
      createHash('sha256').update(challenge.entryCode).digest('hex'),
      '2026-07-27T10:00:01.000Z',
    )
    if (claimed === null) throw new Error('expected claim')
    await h.vault.stage(claimed.vaultKey, claimed.id, bytes('provider-key-test-value'))

    await expect(ingress.revoke(BINDING)).resolves.toMatchObject({ ok: true })
    expect(h.staged.size).toBe(0)
    expect(h.record()).toMatchObject({ status: 'revoked' })
  })

  it('revokes active material before publishing revoked metadata', async () => {
    const h = setup()
    const ingress = h.make()
    await ingress.issue(BINDING)
    await ingress.submit(ENTRY_CODE, bytes('provider-key-test-value'))

    await expect(ingress.revoke(BINDING)).resolves.toEqual({
      ok: true,
      safeDetail: 'API credential was revoked.',
    })
    expect(h.active.size).toBe(0)
    expect(h.record()).toMatchObject({ status: 'revoked' })
    await expect(ingress.validate(BINDING)).resolves.toMatchObject({
      ok: false, errorCode: 'API_CREDENTIAL_NOT_READY',
    })
  })
})

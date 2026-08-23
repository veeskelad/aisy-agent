import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type { ApiCredentialIssuedRecord } from './api-credential-ingress.js'
import {
  makeSqliteApiCredentialIngressStore,
  SqliteApiCredentialIngressStoreError,
} from './sqlite-api-credential-ingress-store.js'

const roots: string[] = []

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-api-credential-')))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function issued(id: string, code: string, second = 0): ApiCredentialIssuedRecord {
  const issuedAt = `2026-07-27T10:00:${String(second).padStart(2, '0')}.000Z`
  return {
    id,
    connectionId: 'openai-api',
    provider: 'openai',
    vaultKey: 'AISY_PROVIDER_OPENAI_KEY',
    status: 'issued',
    codeHash: digest(code),
    issuedAt,
    expiresAt: '2026-07-27T10:10:00.000Z',
    updatedAt: issuedAt,
  }
}

describe('SQLite API credential ingress store', () => {
  it('resumes exact issued metadata after restart without raw entry-code bytes', async () => {
    const root = temporaryRoot()
    const path = join(root, 'state', 'credential-ingress.sqlite')
    const first = makeSqliteApiCredentialIngressStore({ path })
    const record = issued('credential-1', 'PublicEntryCode_123456')
    await first.issue(record)

    const restarted = makeSqliteApiCredentialIngressStore({ path })
    await expect(restarted.current(record)).resolves.toEqual(record)
    const db = new Database(path, { readonly: true })
    const encoded = JSON.stringify(db.prepare('SELECT * FROM credential_ingress').all())
    db.close()
    expect(encoded).not.toContain('PublicEntryCode_123456')
    expect(encoded).toContain(record.codeHash)
  })

  it('allows exactly one cross-instance claim and removes the reusable hash', async () => {
    const root = temporaryRoot()
    const path = join(root, 'credential-ingress.sqlite')
    const first = makeSqliteApiCredentialIngressStore({ path })
    const second = makeSqliteApiCredentialIngressStore({ path })
    const record = issued('credential-1', 'PublicEntryCode_123456')
    await first.issue(record)

    const one = await first.claim(record.codeHash, '2026-07-27T10:00:01.000Z')
    const replay = await second.claim(record.codeHash, '2026-07-27T10:00:01.000Z')
    expect(one).toMatchObject({ id: record.id, status: 'committing' })
    expect(replay).toBeNull()
    expect(await second.current(record)).not.toHaveProperty('codeHash')
  })

  it('supersedes older pending challenges before they can be claimed', async () => {
    const path = join(temporaryRoot(), 'credential-ingress.sqlite')
    const store = makeSqliteApiCredentialIngressStore({ path })
    const old = issued('credential-1', 'PublicEntryCode_123456')
    const fresh = issued('credential-2', 'AnotherEntryCode_12345', 1)
    await store.issue(old)
    await store.issue(fresh)

    await expect(store.claim(old.codeHash, '2026-07-27T10:00:02.000Z')).resolves.toBeNull()
    await expect(store.claim(fresh.codeHash, '2026-07-27T10:00:02.000Z')).resolves
      .toMatchObject({ id: fresh.id, status: 'committing' })
  })

  it('publishes ready/failure/revoke transitions with exact phase guards', async () => {
    const path = join(temporaryRoot(), 'credential-ingress.sqlite')
    const store = makeSqliteApiCredentialIngressStore({ path })
    const first = issued('credential-1', 'PublicEntryCode_123456')
    await store.issue(first)
    await store.claim(first.codeHash, '2026-07-27T10:00:01.000Z')
    await expect(store.markReady(first.id, '2026-07-27T10:00:02.000Z')).resolves.toBe(true)
    await expect(store.markReady(first.id, '2026-07-27T10:00:03.000Z')).resolves.toBe(false)
    await expect(store.current(first)).resolves.toMatchObject({ status: 'ready' })

    const replacement = issued('credential-2', 'AnotherEntryCode_12345', 4)
    await store.issue(replacement)
    await store.claim(replacement.codeHash, '2026-07-27T10:00:05.000Z')
    await expect(store.markFailed(
      replacement.id,
      'API_CREDENTIAL_REJECTED',
      '2026-07-27T10:00:06.000Z',
    )).resolves.toBe(true)
    await expect(store.current(first)).resolves.toMatchObject({
      id: replacement.id, status: 'failed', lastErrorCode: 'API_CREDENTIAL_REJECTED',
    })
    await expect(store.markRevoked(first, '2026-07-27T10:00:07.000Z')).resolves.toBe(true)
    await expect(store.current(first)).resolves.toMatchObject({ status: 'revoked' })
  })

  it('fails closed for symlink, over-broad permissions and incompatible schema', () => {
    const root = temporaryRoot()
    const outside = join(root, 'outside.sqlite')
    writeFileSync(outside, '', { mode: 0o600 })
    const linked = join(root, 'linked.sqlite')
    symlinkSync(outside, linked)
    expect(() => makeSqliteApiCredentialIngressStore({ path: linked }))
      .toThrow(SqliteApiCredentialIngressStoreError)

    const privatePath = join(root, 'private.sqlite')
    makeSqliteApiCredentialIngressStore({ path: privatePath })
    chmodSync(privatePath, 0o644)
    expect(() => makeSqliteApiCredentialIngressStore({ path: privatePath }))
      .toThrowError(expect.objectContaining({ code: 'UNSAFE_PATH' }))

    const corruptPath = join(root, 'corrupt.sqlite')
    const corrupt = new Database(corruptPath)
    corrupt.exec('CREATE TABLE ingress_control (singleton INTEGER PRIMARY KEY, schema_version INTEGER)')
    corrupt.close()
    chmodSync(corruptPath, 0o600)
    expect(() => makeSqliteApiCredentialIngressStore({ path: corruptPath }))
      .toThrowError(expect.objectContaining({ code: 'STATE_CORRUPT' }))
  })
})

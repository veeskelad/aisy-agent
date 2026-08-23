import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceMigrationManifest } from '@aisy/core'

import {
  makeRollbackRehearsalStore,
  performWorkspaceV2RollbackRehearsal,
  RollbackRehearsalError,
} from './workspace-v2-rollback-rehearsal.js'

const roots: string[] = []
const COHORT = 'migration-2026-07-29'

function root(): string {
  const created = mkdtempSync(join(tmpdir(), 'aisy-rehearsal-'))
  roots.push(created)
  return created
}

function backup(dir: string, name: string, bytes: string): { path: string; sha256: string } {
  const path = join(dir, name)
  writeFileSync(path, bytes, { mode: 0o600 })
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function manifest(backupEntry: { path: string; sha256: string }): WorkspaceMigrationManifest {
  return {
    version: 1,
    migrationId: COHORT,
    phase: 'COMMITTED',
    sourceRegistrySha256: backupEntry.sha256,
    createdArtifacts: [],
    backups: [backupEntry],
    updatedAt: '2026-07-29T10:00:00Z',
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('workspace v2 rollback rehearsal (ADR-0073)', () => {
  it('records evidence only after both backups restore byte-identically', () => {
    const dir = root()
    const registry = backup(dir, 'registry.json', '{"projects":[]}')
    const memory = backup(dir, 'ledger.sqlite', 'ledger-bytes')

    const rehearsal = performWorkspaceV2RollbackRehearsal({
      cohortId: COHORT,
      registryManifest: manifest(registry),
      memoryBackup: memory,
      scratchRoot: dir,
      nowIso: () => '2026-07-29T11:00:00Z',
      newRehearsalId: () => 'rehearsal-1',
    })

    expect(rehearsal).toEqual({
      rehearsalId: 'rehearsal-1',
      cohortId: COHORT,
      performedAt: '2026-07-29T11:00:00Z',
      restoredRegistrySha256: registry.sha256,
      restoredMemoryLedgerSha256: memory.sha256,
      verdict: 'passed',
    })
  })

  it('leaves no scratch directory behind, on success or failure', () => {
    const dir = root()
    const registry = backup(dir, 'registry.json', '{}')
    const memory = backup(dir, 'ledger.sqlite', 'ledger')
    const before = readdirSync(dir).length

    performWorkspaceV2RollbackRehearsal({
      cohortId: COHORT,
      registryManifest: manifest(registry),
      memoryBackup: memory,
      scratchRoot: dir,
      nowIso: () => '2026-07-29T11:00:00Z',
    })
    expect(readdirSync(dir).length).toBe(before)

    expect(() => performWorkspaceV2RollbackRehearsal({
      cohortId: COHORT,
      registryManifest: manifest(registry),
      memoryBackup: { path: join(dir, 'missing.sqlite'), sha256: 'f'.repeat(64) },
      scratchRoot: dir,
      nowIso: () => '2026-07-29T11:00:00Z',
    })).toThrowError(RollbackRehearsalError)
    expect(readdirSync(dir).length).toBe(before)
  })

  it('refuses a backup whose bytes no longer match the recorded hash', () => {
    const dir = root()
    const registry = backup(dir, 'registry.json', '{}')
    const memory = backup(dir, 'ledger.sqlite', 'ledger')
    writeFileSync(registry.path, 'tampered', { mode: 0o600 })

    expect(() => performWorkspaceV2RollbackRehearsal({
      cohortId: COHORT,
      registryManifest: manifest(registry),
      memoryBackup: memory,
      scratchRoot: dir,
      nowIso: () => '2026-07-29T11:00:00Z',
    })).toThrowError(expect.objectContaining({ reason: 'restore-mismatch' }))
  })

  it('refuses a missing backup and an empty cohort id', () => {
    const dir = root()
    const memory = backup(dir, 'ledger.sqlite', 'ledger')

    expect(() => performWorkspaceV2RollbackRehearsal({
      cohortId: COHORT,
      registryManifest: manifest({ path: join(dir, 'gone.json'), sha256: 'a'.repeat(64) }),
      memoryBackup: memory,
      scratchRoot: dir,
      nowIso: () => '2026-07-29T11:00:00Z',
    })).toThrowError(expect.objectContaining({ reason: 'backup-missing' }))

    expect(() => performWorkspaceV2RollbackRehearsal({
      cohortId: '',
      registryManifest: manifest(backup(dir, 'r2.json', '{}')),
      memoryBackup: memory,
      scratchRoot: dir,
      nowIso: () => '2026-07-29T11:00:00Z',
    })).toThrowError(expect.objectContaining({ reason: 'cohort-invalid' }))
  })
})

describe('rollback rehearsal store', () => {
  it('persists a rehearsal privately and returns it for its own cohort after restart', () => {
    const path = join(root(), 'state', 'rehearsals.json')
    const store = makeRollbackRehearsalStore({ path })
    const record = {
      rehearsalId: 'rehearsal-1',
      cohortId: COHORT,
      performedAt: '2026-07-29T11:00:00Z',
      restoredRegistrySha256: 'a'.repeat(64),
      restoredMemoryLedgerSha256: 'b'.repeat(64),
      verdict: 'passed' as const,
    }
    store.save(record)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(makeRollbackRehearsalStore({ path }).load(COHORT)).toEqual(record)
    expect(makeRollbackRehearsalStore({ path }).load('other-cohort')).toBeNull()
  })

  it('returns the latest rehearsal of a cohort', () => {
    const path = join(root(), 'rehearsals.json')
    const store = makeRollbackRehearsalStore({ path })
    const base = {
      cohortId: COHORT,
      restoredRegistrySha256: 'a'.repeat(64),
      restoredMemoryLedgerSha256: 'b'.repeat(64),
      verdict: 'passed' as const,
    }
    store.save({ ...base, rehearsalId: 'rehearsal-1', performedAt: '2026-07-29T11:00:00Z' })
    store.save({ ...base, rehearsalId: 'rehearsal-2', performedAt: '2026-07-29T12:00:00Z' })

    expect(store.load(COHORT)?.rehearsalId).toBe('rehearsal-2')
  })

  it('treats corrupt, oversized and partially invalid state as no rehearsal', () => {
    const corrupt = join(root(), 'rehearsals.json')
    writeFileSync(corrupt, '{ not json', { mode: 0o600 })
    expect(makeRollbackRehearsalStore({ path: corrupt }).load(COHORT)).toBeNull()

    const invalid = join(root(), 'rehearsals.json')
    writeFileSync(invalid, JSON.stringify({
      schemaVersion: 1,
      rehearsals: [{ rehearsalId: 'x', cohortId: COHORT, verdict: 'failed' }],
    }), { mode: 0o600 })
    expect(makeRollbackRehearsalStore({ path: invalid }).load(COHORT)).toBeNull()
  })

  it('refuses to persist a record that is not a passed rehearsal', () => {
    const store = makeRollbackRehearsalStore({ path: join(root(), 'rehearsals.json') })
    expect(() => store.save({
      rehearsalId: 'x',
      cohortId: COHORT,
      performedAt: 'yesterday',
      restoredRegistrySha256: 'a'.repeat(64),
      restoredMemoryLedgerSha256: 'b'.repeat(64),
      verdict: 'passed',
    })).toThrowError(RollbackRehearsalError)
  })
})

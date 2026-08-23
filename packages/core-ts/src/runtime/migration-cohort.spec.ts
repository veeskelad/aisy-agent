import { describe, expect, it } from 'vitest'

import { memoryMigrationManifestPath, verifyMigrationCohort } from './migration-cohort.js'
import type { LegacyMemoryMigrationManifest } from './legacy-memory-migration.js'
import type { WorkspaceMigrationManifest } from './project-registry-v2.js'

const REGISTRY_SHA = 'a'.repeat(64)
const COHORT = 'migration-2026-07-29'

const STAGING = '/private/tmp/aisy-cohort-staging'
const paths = () => ({ stagingRoot: STAGING, manifestPath: memoryMigrationManifestPath(STAGING, COHORT) })

const registry = (overrides: Partial<WorkspaceMigrationManifest> = {}): WorkspaceMigrationManifest => ({
  version: 1,
  migrationId: COHORT,
  phase: 'COMMITTED',
  sourceRegistrySha256: REGISTRY_SHA,
  createdArtifacts: [],
  backups: [],
  updatedAt: '2026-07-29T10:00:00Z',
  ...overrides,
})

const memory = (overrides: Partial<LegacyMemoryMigrationManifest> = {}): LegacyMemoryMigrationManifest => ({
  version: 1,
  migrationId: COHORT,
  cohort: { registryMigrationId: COHORT, sourceRegistrySha256: REGISTRY_SHA },
  phase: 'VERIFIED',
  sourceDbPath: '/tmp/memory-v1.sqlite',
  sourceDbSha256: 'b'.repeat(64),
  startedAt: '2026-07-29T10:00:00Z',
  updatedAt: '2026-07-29T10:05:00Z',
  scope: { kind: 'global', scopeId: 'global' },
  counts: { facts: 0, forgotten: 0, published: 0 },
  backup: { path: '/tmp/run/memory-v1.backup.sqlite', sha256: 'c'.repeat(64), bytes: 1 },
  ledger: { path: '/tmp/run/protected-ledger-v2.candidate.sqlite', sha256: 'd'.repeat(64), bytes: 1 },
  factFiles: [],
  ...overrides,
})

describe('verifyMigrationCohort', () => {
  it('binds two manifests that name the same cohort and reports activation readiness', () => {
    const verdict = verifyMigrationCohort({ registry: registry(), memory: memory(), ...paths() })
    expect(verdict).toEqual({ ok: true, cohortId: COHORT, bothMigrationsTerminal: true })
  })

  it('refuses a memory manifest without a cohort binding', () => {
    const broken = memory({ cohort: undefined as never })
    expect(verifyMigrationCohort({ registry: registry(), memory: broken, ...paths() }))
      .toEqual({ ok: false, reason: 'cohort-missing' })
  })

  it('refuses a malformed registry source hash inside the cohort', () => {
    const broken = memory({ cohort: { registryMigrationId: COHORT, sourceRegistrySha256: 'not-a-hash' } })
    expect(verifyMigrationCohort({ registry: registry(), memory: broken, ...paths() }))
      .toEqual({ ok: false, reason: 'cohort-missing' })
  })

  it('refuses manifests from different migrations even when phases match', () => {
    const other = memory({
      migrationId: 'other-migration',
      cohort: { registryMigrationId: 'other-migration', sourceRegistrySha256: REGISTRY_SHA },
    })
    expect(verifyMigrationCohort({ registry: registry(), memory: other, ...paths() }))
      .toEqual({ ok: false, reason: 'cohort-mismatch' })
  })

  it('refuses a cohort field that disagrees with the manifest it lives in', () => {
    const forged = memory({ cohort: { registryMigrationId: COHORT, sourceRegistrySha256: REGISTRY_SHA }, migrationId: 'renamed' })
    expect(verifyMigrationCohort({ registry: registry(), memory: forged, ...paths() }))
      .toEqual({ ok: false, reason: 'cohort-mismatch' })
  })

  it('refuses a re-prepared registry that kept its id but changed its source', () => {
    const reprepared = registry({ sourceRegistrySha256: 'e'.repeat(64) })
    expect(verifyMigrationCohort({ registry: reprepared, memory: memory(), ...paths() }))
      .toEqual({ ok: false, reason: 'registry-source-mismatch' })
  })

  it('is not activation-ready until both migrations reach a terminal phase', () => {
    const early = verifyMigrationCohort({ registry: registry({ phase: 'VERIFIED' }), memory: memory(), ...paths() })
    expect(early).toEqual({ ok: true, cohortId: COHORT, bothMigrationsTerminal: false })

    const memoryEarly = verifyMigrationCohort({ registry: registry(), memory: memory({ phase: 'COPIED' }), ...paths() })
    expect(memoryEarly).toEqual({ ok: true, cohortId: COHORT, bothMigrationsTerminal: false })
  })

  it('accepts only the manifest path derived from the cohort', () => {
    const stagingRoot = '/tmp/staging'
    const derived = memoryMigrationManifestPath(stagingRoot, COHORT)
    expect(verifyMigrationCohort({ registry: registry(), memory: memory(), stagingRoot, manifestPath: derived }))
      .toEqual({ ok: true, cohortId: COHORT, bothMigrationsTerminal: true })
    expect(verifyMigrationCohort({
      registry: registry(),
      memory: memory(),
      stagingRoot,
      manifestPath: '/tmp/staging/memory-scanned-by-mtime.json',
    })).toEqual({ ok: false, reason: 'manifest-path-mismatch' })
  })

  it('refuses a relative staging root instead of anchoring the cohort to cwd', () => {
    expect(verifyMigrationCohort({
      registry: registry(),
      memory: memory(),
      stagingRoot: 'relative/staging',
      manifestPath: 'relative/staging/memory-anything.json',
    })).toEqual({ ok: false, reason: 'manifest-path-mismatch' })
    expect(() => memoryMigrationManifestPath('relative/staging', COHORT)).toThrow()
  })

  it('ignores an inherited cohort from a polluted prototype', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>
    proto.cohort = { registryMigrationId: COHORT, sourceRegistrySha256: REGISTRY_SHA }
    try {
      const withoutOwnCohort = memory()
      delete (withoutOwnCohort as { cohort?: unknown }).cohort
      expect(verifyMigrationCohort({ registry: registry(), memory: withoutOwnCohort, ...paths() }))
        .toEqual({ ok: false, reason: 'cohort-missing' })
    } finally {
      delete proto.cohort
    }
  })

  it('binds on one snapshot of the registry id — an accessor cannot change it mid-check', () => {
    let reads = 0
    const hostile = { ...registry() }
    Object.defineProperty(hostile, 'migrationId', {
      enumerable: true,
      get() { reads += 1; return reads === 1 ? COHORT : 'other-migration' },
    })

    const verdict = verifyMigrationCohort({
      registry: hostile,
      memory: memory(),
      stagingRoot: '/tmp/staging',
      manifestPath: memoryMigrationManifestPath('/tmp/staging', COHORT),
    })
    // The property must be consulted exactly once — otherwise the check and the
    // derived path could disagree — and the verdict must name the id it validated.
    expect(reads).toBe(1)
    expect(verdict).toEqual({ ok: true, cohortId: COHORT, bothMigrationsTerminal: true })
  })

  it('derives a stable, cohort-specific manifest path', () => {
    expect(memoryMigrationManifestPath('/tmp/staging', COHORT))
      .toBe(memoryMigrationManifestPath('/tmp/staging', COHORT))
    expect(memoryMigrationManifestPath('/tmp/staging', COHORT))
      .not.toBe(memoryMigrationManifestPath('/tmp/staging', 'other-cohort'))
    expect(() => memoryMigrationManifestPath('/tmp/staging', '')).toThrow()
  })
})

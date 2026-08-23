import { describe, expect, it } from 'vitest'
import {
  memoryMigrationManifestPath,
  planWorkspaceRegistryV1Migration,
  type ProjectRegistryState,
  type WorkspaceMigrationManifest,
} from '@aisy/core'
import {
  inspectLegacyMemoryMigrationBundle,
  inspectWorkspaceRegistryMigrationBundle,
  makeWorkspaceV2ReadinessProbe,
} from './workspace-v2-readiness-runtime.js'

function registryFixture() {
  const source: ProjectRegistryState = { version: 1, projects: [], sessions: [], selections: [] }
  const sourceBytes = JSON.stringify(source, null, 2) + '\n'
  const sourceRegistryPath = '/Users/operator/.aisy/projects.json'
  const manifestPath = '/Users/operator/.aisy/migrations/workspace-v2.json'
  const stagingRoot = '/Users/operator/.aisy/migrations/staging'
  const plan = planWorkspaceRegistryV1Migration({
    sourceBytes,
    owners: [{
      operatorId: 'telegram:42',
      profileId: 'default',
      workspaceRoot: '/Users/operator/workspace',
    }],
    policy: {
      homeRoot: '/Users/operator',
      projectsRoot: '/Users/operator/projects',
      protectedRoots: ['/Users/operator/.aisy'],
    },
    stagingRoot,
    migrationId: 'migration-1',
    nowIso: () => '2026-07-27T12:00:00.000Z',
    newId: (() => { let id = 0; return () => `id-${++id}` })(),
  })
  const durable: WorkspaceMigrationManifest = { ...plan.manifest, phase: 'VERIFIED' }
  const files = new Map<string, string>([
    [sourceRegistryPath, plan.backupBytes],
    [plan.manifest.backups[0]!.path, plan.backupBytes],
    [plan.manifest.createdArtifacts[0]!.path, plan.candidateBytes],
    [manifestPath, JSON.stringify(durable)],
  ])
  return {
    input: {
      plan,
      sourceRegistryPath,
      manifestPath,
      stagingRoot,
      exists: (path: string) => files.has(path),
      manifestStore: {
        load: () => durable,
        saveAtomic: () => { throw new Error('READ_ONLY_INSPECTOR_WROTE') },
      },
      fs: { readFile: (path: string) => files.get(path) },
    },
    files,
  }
}

describe('workspace v2 readiness runtime', () => {
  it('verifies the real registry bundle without invoking persistence writes', () => {
    const fixture = registryFixture()

    expect(inspectWorkspaceRegistryMigrationBundle(fixture.input)).toEqual({
      phase: 'VERIFIED',
      bundleVerified: true,
    })
  })

  it('fails registry evidence closed after candidate tampering', () => {
    const fixture = registryFixture()
    fixture.files.set(fixture.input.plan.manifest.createdArtifacts[0]!.path, 'tampered')

    expect(inspectWorkspaceRegistryMigrationBundle(fixture.input)).toEqual({
      phase: 'VERIFIED',
      bundleVerified: false,
    })
  })

  it('distinguishes an absent memory manifest from a corrupt one', () => {
    const input = {
      sourceDbPath: '/private/tmp/legacy.sqlite',
      stagingRoot: '/private/tmp',
      registryManifest: {
        version: 1 as const,
        migrationId: 'cohort-1',
        phase: 'VERIFIED' as const,
        sourceRegistrySha256: 'a'.repeat(64),
        createdArtifacts: [],
        backups: [],
        updatedAt: '2026-07-29T10:00:00Z',
      },
      exists: () => false,
      readFile: () => '{corrupt',
    }
    expect(inspectLegacyMemoryMigrationBundle(input)).toEqual({
      phase: null,
      bundleVerified: false,
    })
    expect(inspectLegacyMemoryMigrationBundle({ ...input, exists: () => true })).toEqual({
      phase: 'PREPARED',
      bundleVerified: false,
    })
  })

  it('refuses a memory manifest that does not belong to the registry cohort', () => {
    const registryManifest = {
      version: 1 as const,
      migrationId: 'cohort-1',
      phase: 'VERIFIED' as const,
      sourceRegistrySha256: 'a'.repeat(64),
      createdArtifacts: [],
      backups: [],
      updatedAt: '2026-07-29T10:00:00Z',
    }
    const derived = memoryMigrationManifestPath('/private/tmp', 'cohort-1')
    // A manifest sitting at the right path but naming another registry preparation
    // never produces verified evidence; it is refused during parsing, before the
    // bundle verifier is reached, so the reported phase stays the fail-closed default.
    const foreign = {
      version: 1,
      migrationId: 'cohort-1',
      cohort: { registryMigrationId: 'cohort-1', sourceRegistrySha256: 'b'.repeat(64) },
      phase: 'VERIFIED',
      sourceDbPath: '/private/tmp/memory-v1.sqlite',
      sourceDbSha256: 'c'.repeat(64),
      startedAt: '2026-07-29T10:00:00Z',
      updatedAt: '2026-07-29T10:05:00Z',
      scope: { kind: 'global', scopeId: 'global' },
      counts: { facts: 0, forgotten: 0, published: 0 },
      backup: { path: '/private/tmp/run/memory-v1.backup.sqlite', sha256: 'd'.repeat(64), bytes: 1 },
      ledger: { path: '/private/tmp/run/protected-ledger-v2.candidate.sqlite', sha256: 'e'.repeat(64), bytes: 1 },
      factFiles: [],
    }

    expect(inspectLegacyMemoryMigrationBundle({
      sourceDbPath: '/private/tmp/memory-v1.sqlite',
      stagingRoot: '/private/tmp',
      registryManifest,
      exists: path => path === derived,
      readFile: () => JSON.stringify(foreign),
    })).toEqual({ phase: 'PREPARED', bundleVerified: false })
  })

  it('refuses evidence when the registry manifest itself is malformed', () => {
    expect(inspectLegacyMemoryMigrationBundle({
      sourceDbPath: '/private/tmp/memory-v1.sqlite',
      stagingRoot: '/private/tmp',
      registryManifest: {
        version: 1,
        migrationId: 'cohort-1',
        phase: 'VERIFIED',
        sourceRegistrySha256: 'not-a-hash',
        createdArtifacts: [],
        backups: [],
        updatedAt: '2026-07-29T10:00:00Z',
      } as unknown as WorkspaceMigrationManifest,
      exists: () => true,
      readFile: () => '{}',
    })).toEqual({ phase: 'PREPARED', bundleVerified: false })
  })

  it('never reads a memory manifest outside the cohort-derived path (ADR-0070)', () => {
    const read: string[] = []
    const evidence = inspectLegacyMemoryMigrationBundle({
      sourceDbPath: '/private/tmp/legacy.sqlite',
      stagingRoot: '/private/tmp',
      registryManifest: {
        version: 1,
        migrationId: 'cohort-1',
        phase: 'VERIFIED',
        sourceRegistrySha256: 'a'.repeat(64),
        createdArtifacts: [],
        backups: [],
        updatedAt: '2026-07-29T10:00:00Z',
      },
      exists: path => { read.push(path); return false },
      readFile: () => '{}',
    })

    expect(evidence).toEqual({ phase: null, bundleVerified: false })
    expect(read).toEqual([memoryMigrationManifestPath('/private/tmp', 'cohort-1')])
  })

  it('requires verified bundles, all runtime surfaces, lock availability, and rollback rehearsal', () => {
    const probe = makeWorkspaceV2ReadinessProbe({
      registry: () => ({ phase: 'VERIFIED', bundleVerified: true }),
      memory: () => ({ phase: 'VERIFIED', bundleVerified: true }),
      runtime: {
        registry: () => true,
        scopedMemory: () => true,
        layeredContext: () => true,
        transcript: () => true,
        confinement: () => true,
      },
      rollback: {
        exclusiveLockAvailable: () => true,
        dryRunVerified: () => true,
      },
    })

    expect(probe.workspaceV2()).toEqual(expect.objectContaining({
      state: 'ready-for-approval',
      ok: true,
      readyForActivation: true,
      issues: [],
    }))
  })

  it('turns thrown readiness checks into deterministic failures without exposing errors', () => {
    const probe = makeWorkspaceV2ReadinessProbe({
      registry: () => { throw new Error('/private/registry') },
      memory: () => ({ phase: 'VERIFIED', bundleVerified: true }),
      runtime: {
        registry: () => { throw new Error('secret') },
        scopedMemory: () => true,
        layeredContext: () => true,
        transcript: () => true,
        confinement: () => true,
      },
      rollback: {
        exclusiveLockAvailable: () => true,
        dryRunVerified: () => true,
      },
    })

    const report = probe.workspaceV2()
    expect(report.ok).toBe(false)
    expect(report.issues).toContain('REGISTRY_BUNDLE_UNVERIFIED')
    expect(JSON.stringify(report)).not.toContain('/private/registry')
    expect(JSON.stringify(report)).not.toContain('secret')
  })
})

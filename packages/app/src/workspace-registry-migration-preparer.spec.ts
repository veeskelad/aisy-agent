import { describe, expect, it } from 'vitest'
import {
  planWorkspaceRegistryV1Migration,
  type ProjectRegistryState,
} from '@aisy/core'
import { makeWorkspaceMigrationLock } from './workspace-migration-lock.js'
import { makeJsonWorkspaceMigrationManifestStore } from './workspace-migration-store.js'
import {
  prepareWorkspaceRegistryMigration,
  resumeWorkspaceRegistryMigrationPreparation,
  verifyWorkspaceRegistryMigrationBundle,
  WorkspaceRegistryMigrationPreparationError,
} from './workspace-registry-migration-preparer.js'

const SOURCE_PATH = '/Users/operator/.aisy/projects.json'
const MANIFEST_PATH = '/Users/operator/.aisy/migrations/workspace-v2.json'
const STAGING_ROOT = '/Users/operator/.aisy/migrations/staging'

function setup(options: { corruptCandidate?: boolean } = {}) {
  const source: ProjectRegistryState = {
    version: 1,
    projects: [],
    sessions: [],
    selections: [],
  }
  const sourceBytes = JSON.stringify(source, null, 2) + '\n'
  const files = new Map<string, string>([[SOURCE_PATH, sourceBytes]])
  const directories = new Set<string>([
    '/Users/operator/.aisy/migrations',
    STAGING_ROOT,
  ])
  const calls: string[] = []
  let id = 0
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
    stagingRoot: STAGING_ROOT,
    migrationId: 'migration-1',
    nowIso: () => '2026-07-26T21:00:00.000Z',
    newId: () => `id-${++id}`,
  })
  const fs = {
    readFile: (path: string) => files.get(path),
    createDirectoryExclusive: (path: string) => {
      calls.push(`mkdir-exclusive:${path}`)
      if (directories.has(path)) return false
      directories.add(path)
      return true
    },
    writeFile: (path: string, content: string) => {
      calls.push(`write:${path}`)
      files.set(path, content)
    },
    writeFileExclusive: (path: string, content: string) => {
      calls.push(`write-exclusive:${path}`)
      if (files.has(path)) throw new Error('EEXIST')
      const candidatePath = plan.manifest.createdArtifacts[0]!.path
      files.set(path, options.corruptCandidate && path === candidatePath ? content + 'corrupt' : content)
    },
    syncFile: (path: string) => calls.push(`sync-file:${path}`),
    renameFile: (from: string, to: string) => {
      calls.push(`rename:${from}->${to}`)
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    syncDirectory: (path: string) => calls.push(`sync-dir:${path}`),
    removeFile: (path: string) => { files.delete(path) },
    removeDirectory: (path: string) => { directories.delete(path) },
  }
  const lock = makeWorkspaceMigrationLock({
    lockPath: '/Users/operator/.aisy/migrations/workspace-v2.lock',
    ...fs,
    nowIso: () => '2026-07-26T21:00:00.000Z',
    pid: 42,
    bootId: 'boot-1',
    newNonce: () => 'nonce-1',
  })
  const manifestStore = makeJsonWorkspaceMigrationManifestStore({
    path: MANIFEST_PATH,
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? '',
    writeFile: fs.writeFile,
    syncFile: fs.syncFile,
    renameFile: fs.renameFile,
    syncDirectory: fs.syncDirectory,
  })
  return { calls, directories, files, fs, lock, manifestStore, plan, sourceBytes }
}

describe('prepareWorkspaceRegistryMigration', () => {
  it('creates byte-exact backup and verified candidate but never activates v2', () => {
    const state = setup()

    const result = prepareWorkspaceRegistryMigration({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      manifestPath: MANIFEST_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => '2026-07-26T21:01:00.000Z',
    })

    expect(result.manifest.phase).toBe('VERIFIED')
    expect(state.manifestStore.load().phase).toBe('VERIFIED')
    expect(state.files.get(state.plan.manifest.backups[0]!.path)).toBe(state.sourceBytes)
    expect(state.files.get(state.plan.manifest.createdArtifacts[0]!.path)).toBe(state.plan.candidateBytes)
    expect(state.directories.has('/Users/operator/.aisy/migrations/workspace-v2.lock')).toBe(false)
  })

  it('refuses stale planning before creating manifest or staging artifacts', () => {
    const state = setup()
    state.files.set(SOURCE_PATH, state.sourceBytes + 'changed')

    expect(() => prepareWorkspaceRegistryMigration({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      manifestPath: MANIFEST_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'now',
    })).toThrowError(expect.objectContaining({ code: 'SOURCE_CHANGED' }))
    expect(state.files.has(MANIFEST_PATH)).toBe(false)
    expect(state.files.has(state.plan.manifest.backups[0]!.path)).toBe(false)
  })

  it('stops at COPIED when reread hash verification fails', () => {
    const state = setup({ corruptCandidate: true })

    expect(() => prepareWorkspaceRegistryMigration({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      manifestPath: MANIFEST_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'now',
    })).toThrow(WorkspaceRegistryMigrationPreparationError)
    expect(state.manifestStore.load().phase).toBe('COPIED')
  })

  it('refuses to overwrite an existing migration manifest', () => {
    const state = setup()
    state.files.set(MANIFEST_PATH, JSON.stringify({ phase: 'unknown' }))

    expect(() => prepareWorkspaceRegistryMigration({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      manifestPath: MANIFEST_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'now',
    })).toThrowError(expect.objectContaining({ code: 'MIGRATION_ALREADY_EXISTS' }))
  })

  it('resumes a COPIED migration after repairing an interrupted/corrupt artifact', () => {
    const state = setup({ corruptCandidate: true })
    expect(() => prepareWorkspaceRegistryMigration({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      manifestPath: MANIFEST_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'first',
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_VERIFICATION_FAILED' }))
    expect(state.manifestStore.load().phase).toBe('COPIED')

    state.files.set(state.plan.manifest.createdArtifacts[0]!.path, state.plan.candidateBytes)
    const resumed = resumeWorkspaceRegistryMigrationPreparation({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'retry',
    })

    expect(resumed.manifest.phase).toBe('VERIFIED')
  })

  it('refuses resume when the durable manifest does not belong to the supplied plan', () => {
    const state = setup()
    prepareWorkspaceRegistryMigration({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      manifestPath: MANIFEST_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'first',
    })
    const wrongPlan = {
      ...state.plan,
      manifest: { ...state.plan.manifest, migrationId: 'different' },
    }

    expect(() => resumeWorkspaceRegistryMigrationPreparation({
      plan: wrongPlan,
      sourceRegistryPath: SOURCE_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'retry',
    })).toThrowError(expect.objectContaining({ code: 'MANIFEST_MISMATCH' }))
  })

  it('rechecks artifacts even when the durable phase already says VERIFIED', () => {
    const state = setup()
    prepareWorkspaceRegistryMigration({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      manifestPath: MANIFEST_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'first',
    })
    state.files.set(state.plan.manifest.createdArtifacts[0]!.path, 'tampered')

    expect(() => resumeWorkspaceRegistryMigrationPreparation({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'retry',
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_VERIFICATION_FAILED' }))
  })

  it('revalidates a VERIFIED bundle without writes or lock acquisition', () => {
    const state = setup()
    prepareWorkspaceRegistryMigration({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      manifestPath: MANIFEST_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'first',
    })
    state.calls.splice(0)

    const result = verifyWorkspaceRegistryMigrationBundle({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      stagingRoot: STAGING_ROOT,
      manifestStore: state.manifestStore,
      fs: state.fs,
    })

    expect(result.manifest.phase).toBe('VERIFIED')
    expect(state.calls).toEqual([])
  })

  it('fails read-only bundle verification after candidate tampering', () => {
    const state = setup()
    prepareWorkspaceRegistryMigration({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      manifestPath: MANIFEST_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'first',
    })
    state.files.set(state.plan.manifest.createdArtifacts[0]!.path, 'tampered')
    state.calls.splice(0)

    expect(() => verifyWorkspaceRegistryMigrationBundle({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      stagingRoot: STAGING_ROOT,
      manifestStore: state.manifestStore,
      fs: state.fs,
    })).toThrowError(expect.objectContaining({ code: 'ARTIFACT_VERIFICATION_FAILED' }))
    expect(state.calls).toEqual([])
  })

  it('does not compare mutable live registry bytes with the cutover candidate after writes enable', () => {
    const state = setup()
    prepareWorkspaceRegistryMigration({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      manifestPath: MANIFEST_PATH,
      stagingRoot: STAGING_ROOT,
      lock: state.lock,
      manifestStore: state.manifestStore,
      fs: state.fs,
      nowIso: () => 'first',
    })
    const active = {
      ...state.manifestStore.load(),
      phase: 'V2_WRITES_ENABLED' as const,
      updatedAt: 'after-cutover',
    }
    state.files.set(MANIFEST_PATH, JSON.stringify(active))
    state.files.set(SOURCE_PATH, state.plan.candidateBytes + '\n')
    state.calls.splice(0)

    const result = verifyWorkspaceRegistryMigrationBundle({
      plan: state.plan,
      sourceRegistryPath: SOURCE_PATH,
      stagingRoot: STAGING_ROOT,
      manifestStore: state.manifestStore,
      fs: state.fs,
    })

    expect(result.manifest.phase).toBe('V2_WRITES_ENABLED')
    expect(state.calls).toEqual([])
  })
})

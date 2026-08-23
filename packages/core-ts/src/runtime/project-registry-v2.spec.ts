import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ProjectRegistryState } from './project-registry.js'
import {
  advanceWorkspaceMigration,
  makeFreshProjectRegistryV2,
  planWorkspaceRegistryV1Migration,
  makeWorkspaceMigrationCoordinator,
  migrateProjectRegistryV1,
  ProjectRegistryV2Error,
  recoveryModeForWorkspaceMigration,
  resolveWorkspaceRegistryStartupMode,
  verifyProjectRegistryV1Migration,
  validateProjectRegistryStateV2,
  type ProjectRegistryStateV2,
  type WorkspaceMigrationManifest,
} from './project-registry-v2.js'

const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: [
    '/Users/operator/.aisy',
    '/Users/operator/.aisy/vault',
    '/Users/operator/.aisy/inbox',
  ],
}

function idSequence(...ids: string[]): () => string {
  let index = 0
  return () => ids[index++] ?? `generated-${index}`
}

function validState(): ProjectRegistryStateV2 {
  return makeFreshProjectRegistryV2({
    operatorId: 'telegram:42',
    profileId: 'default',
    workspaceRoot: '/Users/operator/workspace',
    nowIso: () => '2026-07-26T20:00:00.000Z',
    newId: idSequence('workspace-1', 'session-1'),
    policy: POLICY,
  })
}

describe('ProjectRegistry v2 foundation', () => {
  it('WP-01: fresh state creates exactly one selected Workspace and one session', () => {
    const state = validState()

    expect(state.version).toBe(2)
    expect(state.projects).toEqual([expect.objectContaining({
      id: 'workspace-1',
      kind: 'workspace',
      origin: 'workspace',
      root: '/Users/operator/workspace',
    })])
    expect(state.sessions).toEqual([expect.objectContaining({
      id: 'session-1',
      projectId: 'workspace-1',
      status: 'active',
    })])
    expect(state.selections).toEqual([{
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'workspace-1',
      sessionId: 'session-1',
      generation: 1,
    }])
  })

  it('WP-02: migrates v1 records as legacy Projects and preserves their selection', () => {
    const v1: ProjectRegistryState = {
      version: 1,
      projects: [{
        id: 'legacy-project',
        operatorId: 'telegram:42',
        profileId: 'default',
        name: 'Aisy Repo',
        root: '/Users/operator/code/aisy',
        isDefault: true,
        createdAt: '2026-07-20T00:00:00.000Z',
      }],
      sessions: [{
        id: 'legacy-session',
        projectId: 'legacy-project',
        name: 'Imported session',
        status: 'active',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T01:00:00.000Z',
      }],
      selections: [{
        operatorId: 'telegram:42',
        profileId: 'default',
        projectId: 'legacy-project',
        sessionId: 'legacy-session',
      }],
    }

    const state = migrateProjectRegistryV1({
      state: v1,
      owners: [{
        operatorId: 'telegram:42',
        profileId: 'default',
        workspaceRoot: '/Users/operator/workspace',
      }],
      nowIso: () => '2026-07-26T20:00:00.000Z',
      newId: idSequence('workspace-1', 'workspace-session-1'),
      policy: POLICY,
    })

    expect(state.projects.find((item) => item.id === 'legacy-project')).toEqual(
      expect.objectContaining({
        kind: 'project',
        origin: 'legacy',
        root: '/Users/operator/code/aisy',
      }),
    )
    expect(state.projects.find((item) => item.id === 'workspace-1')).toEqual(
      expect.objectContaining({ kind: 'workspace', origin: 'workspace' }),
    )
    expect(state.sessions.find((item) => item.id === 'legacy-session')).toEqual(
      expect.objectContaining({ projectId: 'legacy-project' }),
    )
    expect(state.selections).toEqual([{
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'legacy-project',
      sessionId: 'legacy-session',
      generation: 1,
    }])
  })

  it('WP-02: creates a Workspace selection when an empty v1 registry has no selection', () => {
    const state = migrateProjectRegistryV1({
      state: { version: 1, projects: [], sessions: [], selections: [] },
      owners: [{
        operatorId: 'telegram:42',
        profileId: 'default',
        workspaceRoot: '/Users/operator/workspace',
      }],
      nowIso: () => '2026-07-26T20:00:00.000Z',
      newId: idSequence('workspace-1', 'workspace-session-1'),
      policy: POLICY,
    })

    expect(state.selections[0]).toMatchObject({
      projectId: 'workspace-1',
      sessionId: 'workspace-session-1',
      generation: 1,
    })
  })

  it('WP-02/WP-06: rejects missing owner configuration and Workspace overlap', () => {
    const v1: ProjectRegistryState = {
      version: 1,
      projects: [{
        id: 'legacy-project',
        operatorId: 'telegram:42',
        profileId: 'default',
        name: 'Legacy',
        root: '/Users/operator/code/legacy',
        isDefault: true,
        createdAt: '2026-07-20T00:00:00.000Z',
      }],
      sessions: [],
      selections: [],
    }
    const common = {
      state: v1,
      nowIso: () => '2026-07-26T20:00:00.000Z',
      newId: idSequence('workspace-1', 'workspace-session-1'),
      policy: POLICY,
    }

    expect(() => migrateProjectRegistryV1({ ...common, owners: [] })).toThrowError(
      expect.objectContaining({ code: 'MISSING_OWNER_CONFIGURATION' }),
    )
    expect(() => migrateProjectRegistryV1({
      ...common,
      newId: idSequence('workspace-1', 'workspace-session-1'),
      owners: [{
        operatorId: 'telegram:42',
        profileId: 'default',
        workspaceRoot: '/Users/operator/code/legacy/workspace',
      }],
    })).toThrowError(expect.objectContaining({ code: 'CORRUPT_STATE' }))
  })

  it('WP-02: proves registry migration equivalence before publication', () => {
    const source: ProjectRegistryState = {
      version: 1,
      projects: [{
        id: 'legacy-project',
        operatorId: 'telegram:42',
        profileId: 'default',
        name: 'Legacy',
        root: '/Users/operator/code/legacy',
        isDefault: true,
        createdAt: '2026-07-20T00:00:00.000Z',
      }],
      sessions: [{
        id: 'legacy-session',
        projectId: 'legacy-project',
        name: 'Old',
        status: 'active',
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
      }],
      selections: [{
        operatorId: 'telegram:42',
        profileId: 'default',
        projectId: 'legacy-project',
        sessionId: 'legacy-session',
      }],
    }
    const owners = [{
      operatorId: 'telegram:42',
      profileId: 'default',
      workspaceRoot: '/Users/operator/workspace',
    }]
    const candidate = migrateProjectRegistryV1({
      state: source,
      owners,
      nowIso: () => '2026-07-26T20:00:00.000Z',
      newId: idSequence('workspace-1', 'workspace-session-1'),
      policy: POLICY,
    })

    expect(verifyProjectRegistryV1Migration({ source, candidate, owners, policy: POLICY })).toEqual({
      legacyProjects: 1,
      legacySessions: 1,
      preservedSelections: 1,
      workspacesCreated: 1,
    })

    candidate.sessions.find((item) => item.id === 'legacy-session')!.name = 'tampered'
    expect(() => verifyProjectRegistryV1Migration({ source, candidate, owners, policy: POLICY })).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_EQUIVALENCE_FAILED' }),
    )
  })

  it('WP-02/WP-05: plans a checksummed byte-exact backup and verified v2 candidate', () => {
    const source: ProjectRegistryState = {
      version: 1,
      projects: [],
      sessions: [],
      selections: [],
    }
    const sourceBytes = JSON.stringify(source, null, 4) + '\n\n'
    const plan = planWorkspaceRegistryV1Migration({
      sourceBytes,
      owners: [{
        operatorId: 'telegram:42',
        profileId: 'default',
        workspaceRoot: '/Users/operator/workspace',
      }],
      policy: POLICY,
      stagingRoot: '/Users/operator/.aisy/migrations/staging',
      migrationId: 'migration/opaque value',
      nowIso: () => '2026-07-26T20:00:00.000Z',
      newId: idSequence('workspace-1', 'workspace-session-1'),
    })

    expect(plan.backupBytes).toBe(sourceBytes)
    expect(plan.manifest.phase).toBe('PREPARED')
    expect(plan.manifest.sourceRegistrySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(plan.manifest.backups).toEqual([{
      path: expect.stringMatching(/\/run-[a-f0-9]{32}\/projects-v1\.backup\.json$/),
      sha256: plan.manifest.sourceRegistrySha256,
    }])
    expect(plan.manifest.createdArtifacts).toEqual([{
      path: expect.stringMatching(/\/run-[a-f0-9]{32}\/projects-v2\.candidate\.json$/),
      sha256: createHash('sha256').update(plan.candidateBytes).digest('hex'),
    }])
    expect(JSON.parse(plan.candidateBytes)).toEqual(plan.candidate)
    expect(plan.equivalence.workspacesCreated).toBe(1)
  })

  it.each([
    ['multiple Workspaces', (state: ProjectRegistryStateV2) => {
      state.projects.push({ ...state.projects[0]!, id: 'workspace-2', root: '/Users/operator/other' })
    }],
    ['overlapping roots', (state: ProjectRegistryStateV2) => {
      state.projects.push({
        id: 'project-1',
        operatorId: 'telegram:42',
        profileId: 'default',
        kind: 'project',
        origin: 'registered',
        name: 'Nested',
        root: '/Users/operator/workspace/nested',
        createdAt: '2026-07-26T20:00:00.000Z',
      })
    }],
    ['a protected root', (state: ProjectRegistryStateV2) => {
      state.projects[0]!.root = '/Users/operator/.aisy/project'
    }],
    ['the home root', (state: ProjectRegistryStateV2) => {
      state.projects[0]!.root = '/Users/operator'
    }],
    ['an invalid slug', (state: ProjectRegistryStateV2) => {
      state.projects.push({
        id: 'project-1',
        operatorId: 'telegram:42',
        profileId: 'default',
        kind: 'project',
        origin: 'registered',
        name: 'Bad slug',
        slug: '../escape',
        root: '/Users/operator/code/safe',
        createdAt: '2026-07-26T20:00:00.000Z',
      })
    }],
    ['a dangling session', (state: ProjectRegistryStateV2) => {
      state.sessions[0]!.projectId = 'missing'
    }],
    ['a foreign selection', (state: ProjectRegistryStateV2) => {
      state.selections[0]!.operatorId = 'telegram:99'
    }],
  ])('WP-06: fails closed for %s', (_label, mutate) => {
    const state = validState()
    mutate(state)

    expect(() => validateProjectRegistryStateV2(state, POLICY)).toThrowError(
      expect.objectContaining({ code: 'CORRUPT_STATE' }),
    )
  })

  it('returns defensive normalized state instead of the caller object', () => {
    const state = validState()
    const validated = validateProjectRegistryStateV2(state, POLICY)

    validated.projects[0]!.name = 'changed'
    expect(state.projects[0]!.name).toBe('Workspace')
  })
})

describe('Workspace v2 migration manifest', () => {
  function manifest(): WorkspaceMigrationManifest {
    return {
      version: 1,
      migrationId: 'migration-1',
      phase: 'PREPARED',
      sourceRegistrySha256: 'a'.repeat(64),
      createdArtifacts: [],
      backups: [],
      updatedAt: '2026-07-26T20:00:00.000Z',
    }
  }

  it('WP-05: only permits the durable forward phase order', () => {
    let state = manifest()
    state = advanceWorkspaceMigration(state, 'PREPARED', 'COPIED', 't1')
    state = advanceWorkspaceMigration(state, 'COPIED', 'VERIFIED', 't2')
    state = advanceWorkspaceMigration(state, 'VERIFIED', 'COMMITTED', 't3')
    state = advanceWorkspaceMigration(state, 'COMMITTED', 'V2_WRITES_ENABLED', 't4')

    expect(state.phase).toBe('V2_WRITES_ENABLED')
    expect(recoveryModeForWorkspaceMigration(state)).toBe('forward-repair')
  })

  it('WP-05: rejects skipped, stale and post-cutover transitions', () => {
    expect(() => advanceWorkspaceMigration(manifest(), 'PREPARED', 'VERIFIED', 't1')).toThrowError(
      expect.objectContaining({ code: 'INVALID_MIGRATION_TRANSITION' }),
    )
    expect(() => advanceWorkspaceMigration(manifest(), 'COPIED', 'VERIFIED', 't1')).toThrowError(
      expect.objectContaining({ code: 'STALE_MIGRATION_PHASE' }),
    )

    const enabled = {
      ...manifest(),
      phase: 'V2_WRITES_ENABLED' as const,
    }
    expect(() => advanceWorkspaceMigration(enabled, 'V2_WRITES_ENABLED', 'COMMITTED', 't1')).toThrow(
      ProjectRegistryV2Error,
    )
    expect(recoveryModeForWorkspaceMigration(manifest())).toBe('rollback-or-resume')
  })

  it.each([
    ['PREPARED', 'COPIED'],
    ['COPIED', 'VERIFIED'],
    ['VERIFIED', 'COMMITTED'],
    ['COMMITTED', 'V2_WRITES_ENABLED'],
  ] as const)('WP-05: crash before atomic %s→%s publication leaves the old phase authoritative', (
    phase,
    next,
  ) => {
    let durable: WorkspaceMigrationManifest = { ...manifest(), phase }
    let fail = true
    const persistence = {
      load: () => durable,
      saveAtomic: (candidate: WorkspaceMigrationManifest) => {
        if (fail) throw new Error('injected crash')
        durable = candidate
      },
    }
    const crashed = makeWorkspaceMigrationCoordinator({ persistence, nowIso: () => 'next' })

    expect(() => crashed.advance(phase, next)).toThrow('injected crash')
    expect(makeWorkspaceMigrationCoordinator({ persistence, nowIso: () => 'restart' }).current().phase).toBe(phase)

    fail = false
    const resumed = makeWorkspaceMigrationCoordinator({ persistence, nowIso: () => 'retry' })
    expect(resumed.advance(phase, next).phase).toBe(next)
    expect(resumed.current().phase).toBe(next)
  })

  it('fails closed on a corrupt persisted migration manifest', () => {
    expect(() => makeWorkspaceMigrationCoordinator({
      persistence: {
        load: () => ({ ...manifest(), sourceRegistrySha256: 'not-a-hash' }),
        saveAtomic: () => {},
      },
      nowIso: () => 'now',
    })).toThrowError(expect.objectContaining({ code: 'CORRUPT_MANIFEST' }))
  })

  it('keeps startup on v1 only when no migration manifest exists', () => {
    expect(resolveWorkspaceRegistryStartupMode(null)).toBe('v1-live')
    expect(resolveWorkspaceRegistryStartupMode(manifest())).toBe('maintenance')
    expect(resolveWorkspaceRegistryStartupMode({
      ...manifest(),
      phase: 'COMMITTED',
    })).toBe('maintenance')
    expect(resolveWorkspaceRegistryStartupMode({
      ...manifest(),
      phase: 'V2_WRITES_ENABLED',
    })).toBe('v2-live')
  })
})

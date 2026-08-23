import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  memoryMigrationManifestPath,
  planWorkspaceRegistryV1Migration,
  workspaceV2ActivationEvidenceHash,
  type ProjectRegistryState,
  type ProjectRegistryV2Policy,
  type WorkspaceV2ActivationApproval,
  type WorkspaceV2ReadinessReport,
} from '@aisy/core'

import { performWorkspaceV2Cutover } from './workspace-v2-cutover.js'
import { makeRollbackRehearsalStore } from './workspace-v2-rollback-rehearsal.js'

const roots: string[] = []
const COHORT = 'cohort-1'

const OWNERS = [{
  operatorId: 'telegram:42',
  profileId: 'default',
  workspaceRoot: '/Users/operator/workspace',
}]

function policyFor(home: string): ProjectRegistryV2Policy {
  return {
    homeRoot: '/Users/operator',
    projectsRoot: '/Users/operator/projects',
    protectedRoots: [home],
  }
}

const READY: WorkspaceV2ReadinessReport = {
  state: 'committed-awaiting-enable',
  ok: true,
  readyForActivation: true,
  activationRequiresApproval: true,
  rollbackMode: 'rollback-or-resume',
  issues: [],
}

/** A fully prepared cohort sitting at COMMITTED, with rehearsal recorded. */
function prepared(options: { withRehearsal?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aisy-cutover-'))
  roots.push(home)
  const migrations = join(home, 'migrations')
  const stagingRoot = join(migrations, 'staging')
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 })

  const source: ProjectRegistryState = { version: 1, projects: [], sessions: [], selections: [] }
  const plan = planWorkspaceRegistryV1Migration({
    sourceBytes: JSON.stringify(source, null, 2) + '\n',
    owners: OWNERS,
    policy: policyFor(home),
    stagingRoot,
    migrationId: COHORT,
    nowIso: () => '2026-07-29T12:00:00Z',
    newId: (() => { let id = 0; return () => `id-${++id}` })(),
  })

  const candidatePath = plan.manifest.createdArtifacts[0]!.path
  mkdirSync(join(candidatePath, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(candidatePath, plan.candidateBytes, { mode: 0o600 })

  const manifest = { ...plan.manifest, phase: 'COMMITTED' as const }
  writeFileSync(join(migrations, 'workspace-v2.json'), JSON.stringify(manifest), { mode: 0o600 })

  const memoryManifestPath = memoryMigrationManifestPath(stagingRoot, COHORT)
  writeFileSync(memoryManifestPath, JSON.stringify({
    version: 1,
    migrationId: COHORT,
    cohort: { registryMigrationId: COHORT, sourceRegistrySha256: manifest.sourceRegistrySha256 },
    phase: 'VERIFIED',
    sourceDbPath: join(home, 'memory.db'),
    sourceDbSha256: 'c'.repeat(64),
    startedAt: '2026-07-29T12:00:00Z',
    updatedAt: '2026-07-29T12:05:00Z',
    scope: { kind: 'global', scopeId: 'global' },
    counts: { facts: 0, forgotten: 0, published: 0 },
    backup: { path: join(stagingRoot, 'b.sqlite'), sha256: 'd'.repeat(64), bytes: 1 },
    ledger: { path: join(stagingRoot, 'l.sqlite'), sha256: 'e'.repeat(64), bytes: 1 },
    factFiles: [],
  }), { mode: 0o600 })

  if (options.withRehearsal !== false) {
    makeRollbackRehearsalStore({ path: join(migrations, 'rehearsals.json') }).save({
      rehearsalId: 'rehearsal-1',
      cohortId: COHORT,
      performedAt: '2026-07-29T11:00:00Z',
      restoredRegistrySha256: 'a'.repeat(64),
      restoredMemoryLedgerSha256: 'b'.repeat(64),
      verdict: 'passed',
    })
  }

  const approval: WorkspaceV2ActivationApproval = {
    cohortId: COHORT,
    evidenceHash: workspaceV2ActivationEvidenceHash({
      report: READY,
      cohortId: COHORT,
      registryPhase: 'COMMITTED',
      memoryPhase: 'VERIFIED',
      sourceRegistrySha256: manifest.sourceRegistrySha256,
      rehearsalId: 'rehearsal-1',
    }),
    approvedBy: 'operator',
    approvedAt: '2026-07-29T12:30:00Z',
  }

  return { home, migrations, approval, manifest }
}

function cutover(fixture: ReturnType<typeof prepared>, approval = fixture.approval) {
  return performWorkspaceV2Cutover({
    home: fixture.home,
    policy: policyFor(fixture.home),
    readiness: READY,
    memoryPhase: 'VERIFIED',
    approval,
    nowIso: () => '2026-07-29T13:00:00Z',
  })
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('workspace v2 cutover (ADR-0073)', () => {
  it('publishes the candidate and moves the manifest to the terminal phase', () => {
    const fixture = prepared()
    const result = cutover(fixture)

    expect(result).toEqual({
      ok: true,
      cohortId: COHORT,
      evidenceHash: fixture.approval.evidenceHash,
      targetPath: join(fixture.home, 'projects-v2.json'),
    })
    expect(statSync(join(fixture.home, 'projects-v2.json')).mode & 0o777).toBe(0o600)

    const manifest = JSON.parse(readFileSync(join(fixture.migrations, 'workspace-v2.json'), 'utf8'))
    expect(manifest.phase).toBe('V2_WRITES_ENABLED')
  })

  it('never activates twice with the same approval', () => {
    const fixture = prepared()
    expect(cutover(fixture).ok).toBe(true)

    // Second attempt: the manifest already moved on, and the approval is spent.
    expect(cutover(fixture)).toEqual({ ok: false, reason: 'already-activated' })
  })

  it('refuses while another cutover holds the lock', () => {
    const fixture = prepared()
    mkdirSync(join(fixture.migrations, 'migration.lock'), { mode: 0o700 })

    expect(cutover(fixture)).toEqual({ ok: false, reason: 'lock-held' })
    expect(existsSync(join(fixture.home, 'projects-v2.json'))).toBe(false)
  })

  it('refuses without a rehearsal for this cohort', () => {
    const fixture = prepared({ withRehearsal: false })
    expect(cutover(fixture)).toEqual({ ok: false, reason: 'rehearsal-missing' })
    expect(existsSync(join(fixture.home, 'projects-v2.json'))).toBe(false)
  })

  it('refuses an approval that answers for a different evidence state', () => {
    const fixture = prepared()
    const stale = { ...fixture.approval, evidenceHash: 'f'.repeat(64) }

    expect(cutover(fixture, stale)).toEqual({ ok: false, reason: 'approval-mismatch' })
    expect(existsSync(join(fixture.home, 'projects-v2.json'))).toBe(false)
  })

  it('refuses when the verified candidate is gone', () => {
    const fixture = prepared()
    rmSync(fixture.manifest.createdArtifacts[0]!.path)

    expect(cutover(fixture)).toEqual({ ok: false, reason: 'candidate-missing' })
  })

  it('releases the lock on every path, so a refusal is retryable', () => {
    const fixture = prepared({ withRehearsal: false })
    expect(cutover(fixture).ok).toBe(false)
    expect(existsSync(join(fixture.migrations, 'migration.lock'))).toBe(false)

    makeRollbackRehearsalStore({ path: join(fixture.migrations, 'rehearsals.json') }).save({
      rehearsalId: 'rehearsal-1',
      cohortId: COHORT,
      performedAt: '2026-07-29T11:00:00Z',
      restoredRegistrySha256: 'a'.repeat(64),
      restoredMemoryLedgerSha256: 'b'.repeat(64),
      verdict: 'passed',
    })
    expect(cutover(fixture).ok).toBe(true)
  })
})

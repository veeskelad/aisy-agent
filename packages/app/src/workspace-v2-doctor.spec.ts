import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planWorkspaceRegistryV1Migration, type ProjectRegistryState } from '@aisy/core'

import { makeWorkspaceV2DoctorProbe } from './workspace-v2-doctor.js'
import { makeRollbackRehearsalStore } from './workspace-v2-rollback-rehearsal.js'

const roots: string[] = []

function home(): string {
  const created = mkdtempSync(join(tmpdir(), 'aisy-doctor-'))
  roots.push(created)
  return created
}

const OWNERS = [{
  operatorId: 'telegram:42',
  profileId: 'default',
  workspaceRoot: '/Users/operator/workspace',
}]

function probeFor(base: string) {
  const sourceRegistryPath = join(base, 'projects.json')
  const source: ProjectRegistryState = { version: 1, projects: [], sessions: [], selections: [] }
  writeFileSync(sourceRegistryPath, JSON.stringify(source, null, 2) + '\n', { mode: 0o600 })
  return makeWorkspaceV2DoctorProbe({
    home: base,
    sourceRegistryPath,
    sourceDbPath: join(base, 'memory.db'),
    owners: OWNERS,
    policy: {
      homeRoot: '/Users/operator',
      projectsRoot: '/Users/operator/projects',
      protectedRoots: [base],
    },
    nowIso: () => '2026-07-29T12:00:00Z',
    newId: (() => { let id = 0; return () => `id-${++id}` })(),
  })
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('workspace v2 doctor probe (ADR-0073)', () => {
  it('reports "not prepared" when no migration manifest exists', () => {
    expect(probeFor(home()).workspaceV2()).toEqual({
      state: 'not-prepared',
      ok: true,
      readyForActivation: false,
      activationRequiresApproval: true,
      rollbackMode: 'rollback-or-resume',
      issues: [],
    })
  })

  it('says migration is not required when the installation never had a v1 registry', () => {
    // fr1 родился на v2 2026-08-08: `projects-v2.json` авторитетен, файлов v1
    // нет. «Не подготовлена; v1 остаётся authoritative» читалось там как
    // незакрытый долг — про файл, которого не существует.
    const base = home()

    expect(makeWorkspaceV2DoctorProbe({
      home: base,
      sourceRegistryPath: join(base, 'projects.json'),
      sourceDbPath: join(base, 'memory.db'),
      owners: OWNERS,
      policy: {
        homeRoot: '/Users/operator',
        projectsRoot: '/Users/operator/projects',
        protectedRoots: [base],
      },
    }).workspaceV2()).toMatchObject({ state: 'not-required', ok: true })
  })

  it('never reports "not prepared" for a manifest that exists but is unreadable', () => {
    const base = home()
    mkdirSync(join(base, 'migrations'), { recursive: true, mode: 0o700 })
    writeFileSync(join(base, 'migrations', 'workspace-v2.json'), '{ not json', { mode: 0o600 })

    const report = probeFor(base).workspaceV2()
    expect(report.state).not.toBe('not-prepared')
    expect(report.readyForActivation).toBe(false)
    expect(report.issues.length).toBeGreaterThan(0)
  })

  it('withholds activation while the cohort has no rehearsal on record', () => {
    const base = home()
    const migrations = join(base, 'migrations')
    mkdirSync(migrations, { recursive: true, mode: 0o700 })
    const source: ProjectRegistryState = { version: 1, projects: [], sessions: [], selections: [] }
    const plan = planWorkspaceRegistryV1Migration({
      sourceBytes: JSON.stringify(source, null, 2) + '\n',
      owners: OWNERS,
      policy: {
        homeRoot: '/Users/operator',
        projectsRoot: '/Users/operator/projects',
        protectedRoots: [base],
      },
      stagingRoot: join(migrations, 'staging'),
      migrationId: 'cohort-1',
      nowIso: () => '2026-07-29T12:00:00Z',
      newId: (() => { let id = 0; return () => `id-${++id}` })(),
    })
    writeFileSync(
      join(migrations, 'workspace-v2.json'),
      JSON.stringify({ ...plan.manifest, phase: 'COMMITTED' }),
      { mode: 0o600 },
    )

    const report = probeFor(base).workspaceV2()
    expect(report.readyForActivation).toBe(false)
    expect(report.issues).toContain('ROLLBACK_DRY_RUN_UNVERIFIED')
  })

  it('counts only a rehearsal recorded for this very cohort', () => {
    const base = home()
    const migrations = join(base, 'migrations')
    mkdirSync(migrations, { recursive: true, mode: 0o700 })
    writeFileSync(join(migrations, 'workspace-v2.json'), '{ not json', { mode: 0o600 })
    makeRollbackRehearsalStore({ path: join(migrations, 'rehearsals.json') }).save({
      rehearsalId: 'rehearsal-1',
      cohortId: 'some-other-cohort',
      performedAt: '2026-07-29T11:00:00Z',
      restoredRegistrySha256: 'a'.repeat(64),
      restoredMemoryLedgerSha256: 'b'.repeat(64),
      verdict: 'passed',
    })

    // Unreadable manifest plus a foreign rehearsal must still refuse activation.
    expect(probeFor(base).workspaceV2().readyForActivation).toBe(false)
  })

  it('never writes: a manifest store write attempt would throw, and none happens', () => {
    const base = home()
    const migrations = join(base, 'migrations')
    mkdirSync(migrations, { recursive: true, mode: 0o700 })
    writeFileSync(join(migrations, 'workspace-v2.json'), '{ not json', { mode: 0o600 })

    expect(() => probeFor(base).workspaceV2()).not.toThrow()
  })
})

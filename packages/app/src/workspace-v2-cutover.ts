// The irreversible Workspace v2 cutover (ADR-0073).
//
// Everything is decided by `authorizeWorkspaceV2Activation`; this file only holds
// the exclusive lock, publishes the already-verified candidate atomically and
// advances the phase. It never plans, never repairs and never retries.

import {
  advanceWorkspaceMigration,
  authorizeWorkspaceV2Activation,
  memoryMigrationManifestPath,
  validateProjectRegistryStateV2,
  validateWorkspaceMigrationManifest,
  verifyMigrationCohort,
  workspaceV2ActivationApprovalKey,
  workspaceV2ActivationEvidenceHash,
  type LegacyMemoryMigrationManifest,
  type ProjectRegistryStateV2,
  type ProjectRegistryV2Policy,
  type WorkspaceMigrationManifest,
  type WorkspaceV2ActivationApproval,
  type WorkspaceV2ActivationRefusal,
  type WorkspaceV2ReadinessReport,
} from '@aisy/core'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { makeRollbackRehearsalStore } from './workspace-v2-rollback-rehearsal.js'

export type WorkspaceV2CutoverRefusal =
  | WorkspaceV2ActivationRefusal
  | 'lock-held'
  | 'manifest-unreadable'
  | 'candidate-missing'
  | 'candidate-invalid'
  | 'target-exists'

export type WorkspaceV2CutoverResult =
  | { ok: true; cohortId: string; evidenceHash: string; targetPath: string }
  | { ok: false; reason: WorkspaceV2CutoverRefusal }

export interface WorkspaceV2CutoverInput {
  home: string
  policy: ProjectRegistryV2Policy
  readiness: WorkspaceV2ReadinessReport
  memoryPhase: string
  approval: WorkspaceV2ActivationApproval
  nowIso: () => string
}

function readSpentApprovals(path: string): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { keys?: unknown }
    return new Set(Array.isArray(parsed.keys)
      ? parsed.keys.filter((key): key is string => typeof key === 'string')
      : [])
  } catch {
    return new Set()
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

/**
 * Perform the cutover. Returns a refusal instead of throwing for every expected
 * denial, so a caller can report it without interpreting exceptions.
 */
export function performWorkspaceV2Cutover(input: WorkspaceV2CutoverInput): WorkspaceV2CutoverResult {
  const migrations = join(input.home, 'migrations')
  const manifestPath = join(migrations, 'workspace-v2.json')
  const stagingRoot = join(migrations, 'staging')
  const targetPath = join(input.home, 'projects-v2.json')
  const lockDirectory = join(migrations, 'migration.lock')

  let manifest: WorkspaceMigrationManifest
  try {
    manifest = validateWorkspaceMigrationManifest(
      JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspaceMigrationManifest,
    )
  } catch {
    return { ok: false, reason: 'manifest-unreadable' }
  }

  // Exclusive by creation: a second cutover attempt cannot even read the state.
  mkdirSync(migrations, { recursive: true, mode: 0o700 })
  try {
    mkdirSync(lockDirectory, { mode: 0o700 })
  } catch {
    return { ok: false, reason: 'lock-held' }
  }

  try {
    const memoryManifestPath = memoryMigrationManifestPath(stagingRoot, manifest.migrationId)
    const memoryManifest = (() => {
      try {
        return JSON.parse(readFileSync(memoryManifestPath, 'utf8')) as LegacyMemoryMigrationManifest
      } catch {
        return null
      }
    })()
    if (memoryManifest === null) return { ok: false, reason: 'manifest-unreadable' }

    const cohort = verifyMigrationCohort({
      registry: manifest,
      memory: memoryManifest,
      stagingRoot,
      manifestPath: memoryManifestPath,
    })

    const rehearsal = makeRollbackRehearsalStore({
      path: join(migrations, 'rehearsals.json'),
    }).load(manifest.migrationId)

    const spentPath = join(migrations, 'activation-approvals.json')
    const spent = readSpentApprovals(spentPath)

    const verdict = authorizeWorkspaceV2Activation({
      report: input.readiness,
      cohort,
      registryPhase: manifest.phase,
      memoryPhase: input.memoryPhase,
      sourceRegistrySha256: manifest.sourceRegistrySha256,
      rehearsal,
      approval: input.approval,
      // Read before deciding, not after publishing: a replayed approval must be
      // refused, and recording it afterwards would be too late.
      usedApprovals: spent,
    })
    if (!verdict.ok) return { ok: false, reason: verdict.reason }

    // The candidate was verified during readiness; publication only moves bytes.
    const candidatePath = manifest.createdArtifacts[0]?.path
    if (candidatePath === undefined || !existsSync(candidatePath)) {
      return { ok: false, reason: 'candidate-missing' }
    }
    let candidate: ProjectRegistryStateV2
    try {
      candidate = validateProjectRegistryStateV2(
        JSON.parse(readFileSync(candidatePath, 'utf8')) as ProjectRegistryStateV2,
        input.policy,
      )
    } catch {
      return { ok: false, reason: 'candidate-invalid' }
    }
    if (existsSync(targetPath)) return { ok: false, reason: 'target-exists' }

    const temporary = `${targetPath}.cutover-${process.pid}-${randomUUID()}`
    writeFileSync(temporary, JSON.stringify(candidate, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    syncPath(temporary)
    renameSync(temporary, targetPath)
    syncPath(input.home)

    // Only after the target exists does the manifest move to the terminal phase:
    // a crash between the two leaves a resumable state, not a lost registry.
    const advanced = advanceWorkspaceMigration(
      manifest,
      'COMMITTED',
      'V2_WRITES_ENABLED',
      input.nowIso(),
    )
    const manifestTemporary = `${manifestPath}.cutover-${process.pid}-${randomUUID()}`
    writeFileSync(manifestTemporary, JSON.stringify(advanced, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    syncPath(manifestTemporary)
    renameSync(manifestTemporary, manifestPath)
    syncPath(migrations)

    // Durable record of the spent approval; the check above already consulted it.
    const spentTemporary = `${spentPath}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(
      spentTemporary,
      JSON.stringify({
        keys: [...spent, workspaceV2ActivationApprovalKey(input.approval)],
      }, null, 2) + '\n',
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    syncPath(spentTemporary)
    renameSync(spentTemporary, spentPath)
    syncPath(migrations)

    return {
      ok: true,
      cohortId: verdict.cohortId,
      evidenceHash: verdict.evidenceHash,
      targetPath,
    }
  } finally {
    rmSync(lockDirectory, { recursive: true, force: true })
  }
}

export { workspaceV2ActivationEvidenceHash }

import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import {
  makeWorkspaceMigrationCoordinator,
  type WorkspaceMigrationManifest,
  type WorkspaceMigrationManifestPersistencePort,
  type WorkspaceRegistryMigrationPlan,
} from '@aisy/core'
import type {
  WorkspaceMigrationLock,
  WorkspaceMigrationLockToken,
} from './workspace-migration-lock.js'

export interface WorkspaceRegistryMigrationPreparationFs {
  readFile(path: string): string | undefined
  createDirectoryExclusive(path: string): boolean
  writeFileExclusive(path: string, content: string): void
  syncFile(path: string): void
  syncDirectory(path: string): void
}

export class WorkspaceRegistryMigrationPreparationError extends Error {
  constructor(
    public readonly code:
      | 'MIGRATION_LOCK_HELD'
      | 'MIGRATION_ALREADY_EXISTS'
      | 'SOURCE_CHANGED'
      | 'UNSAFE_STAGING_PLAN'
      | 'STAGING_EXISTS'
      | 'LOCK_LOST'
      | 'ARTIFACT_VERIFICATION_FAILED'
      | 'MANIFEST_MISMATCH'
      | 'PHASE_NOT_PREPARABLE',
  ) {
    super(code)
    this.name = 'WorkspaceRegistryMigrationPreparationError'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertHeld(lock: WorkspaceMigrationLock, token: WorkspaceMigrationLockToken): void {
  if (!lock.isHeld(token)) throw new WorkspaceRegistryMigrationPreparationError('LOCK_LOST')
}

function validateStagingPaths(
  plan: WorkspaceRegistryMigrationPlan,
  stagingRoot: string,
): { runDirectory: string; backupPath: string; candidatePath: string } {
  const backups = plan.manifest.backups
  const artifacts = plan.manifest.createdArtifacts
  if (backups.length !== 1 || artifacts.length !== 1) {
    throw new WorkspaceRegistryMigrationPreparationError('UNSAFE_STAGING_PLAN')
  }
  const backupPath = backups[0]!.path
  const candidatePath = artifacts[0]!.path
  const runDirectory = dirname(backupPath)
  const canonicalStagingRoot = resolve(stagingRoot)
  if (dirname(runDirectory) !== canonicalStagingRoot || dirname(candidatePath) !== runDirectory ||
    basename(backupPath) !== 'projects-v1.backup.json' ||
    basename(candidatePath) !== 'projects-v2.candidate.json') {
    throw new WorkspaceRegistryMigrationPreparationError('UNSAFE_STAGING_PLAN')
  }
  return { runDirectory, backupPath, candidatePath }
}

function samePlanManifest(
  durable: WorkspaceMigrationManifest,
  planned: WorkspaceMigrationManifest,
): boolean {
  return durable.migrationId === planned.migrationId &&
    durable.sourceRegistrySha256 === planned.sourceRegistrySha256 &&
    JSON.stringify(durable.backups) === JSON.stringify(planned.backups) &&
    JSON.stringify(durable.createdArtifacts) === JSON.stringify(planned.createdArtifacts)
}

function artifactsMatch(input: {
  plan: WorkspaceRegistryMigrationPlan
  fs: Pick<WorkspaceRegistryMigrationPreparationFs, 'readFile'>
  backupPath: string
  candidatePath: string
}): boolean {
  const backupBytes = input.fs.readFile(input.backupPath)
  const candidateBytes = input.fs.readFile(input.candidatePath)
  return backupBytes !== undefined && candidateBytes !== undefined &&
    backupBytes === input.plan.backupBytes && candidateBytes === input.plan.candidateBytes &&
    sha256(backupBytes) === input.plan.manifest.backups[0]!.sha256 &&
    sha256(candidateBytes) === input.plan.manifest.createdArtifacts[0]!.sha256
}

/**
 * Prepares and verifies a registry migration bundle. This function cannot
 * publish projects.json and cannot advance beyond VERIFIED; activation is a
 * separate operator-approved cutover path.
 */
export function prepareWorkspaceRegistryMigration(input: {
  plan: WorkspaceRegistryMigrationPlan
  sourceRegistryPath: string
  manifestPath: string
  stagingRoot: string
  lock: WorkspaceMigrationLock
  manifestStore: WorkspaceMigrationManifestPersistencePort
  fs: WorkspaceRegistryMigrationPreparationFs
  nowIso: () => string
}): { manifest: WorkspaceMigrationManifest } {
  const acquired = input.lock.acquire()
  if (!acquired.ok) {
    throw new WorkspaceRegistryMigrationPreparationError('MIGRATION_LOCK_HELD')
  }
  const token = acquired.token
  try {
    assertHeld(input.lock, token)
    if (input.fs.readFile(input.manifestPath) !== undefined) {
      throw new WorkspaceRegistryMigrationPreparationError('MIGRATION_ALREADY_EXISTS')
    }
    if (input.fs.readFile(input.sourceRegistryPath) !== input.plan.backupBytes) {
      throw new WorkspaceRegistryMigrationPreparationError('SOURCE_CHANGED')
    }
    const paths = validateStagingPaths(input.plan, input.stagingRoot)
    if (!input.fs.createDirectoryExclusive(paths.runDirectory)) {
      throw new WorkspaceRegistryMigrationPreparationError('STAGING_EXISTS')
    }

    assertHeld(input.lock, token)
    input.manifestStore.saveAtomic(input.plan.manifest)

    assertHeld(input.lock, token)
    input.fs.writeFileExclusive(paths.backupPath, input.plan.backupBytes)
    input.fs.syncFile(paths.backupPath)
    input.fs.writeFileExclusive(paths.candidatePath, input.plan.candidateBytes)
    input.fs.syncFile(paths.candidatePath)
    input.fs.syncDirectory(paths.runDirectory)

    const coordinator = makeWorkspaceMigrationCoordinator({
      persistence: input.manifestStore,
      nowIso: input.nowIso,
    })
    assertHeld(input.lock, token)
    coordinator.advance('PREPARED', 'COPIED')

    if (!artifactsMatch({ plan: input.plan, fs: input.fs, ...paths })) {
      throw new WorkspaceRegistryMigrationPreparationError('ARTIFACT_VERIFICATION_FAILED')
    }

    assertHeld(input.lock, token)
    const manifest = coordinator.advance('COPIED', 'VERIFIED')
    return { manifest }
  } finally {
    if (input.lock.isHeld(token)) input.lock.release(token)
  }
}

/** Resumes only the reversible preparation phases; it cannot commit or activate. */
export function resumeWorkspaceRegistryMigrationPreparation(input: {
  plan: WorkspaceRegistryMigrationPlan
  sourceRegistryPath: string
  stagingRoot: string
  lock: WorkspaceMigrationLock
  manifestStore: WorkspaceMigrationManifestPersistencePort
  fs: WorkspaceRegistryMigrationPreparationFs
  nowIso: () => string
}): { manifest: WorkspaceMigrationManifest } {
  const acquired = input.lock.acquire()
  if (!acquired.ok) {
    throw new WorkspaceRegistryMigrationPreparationError('MIGRATION_LOCK_HELD')
  }
  const token = acquired.token
  try {
    assertHeld(input.lock, token)
    const durable = input.manifestStore.load()
    if (!samePlanManifest(durable, input.plan.manifest)) {
      throw new WorkspaceRegistryMigrationPreparationError('MANIFEST_MISMATCH')
    }
    if (input.fs.readFile(input.sourceRegistryPath) !== input.plan.backupBytes) {
      throw new WorkspaceRegistryMigrationPreparationError('SOURCE_CHANGED')
    }
    const paths = validateStagingPaths(input.plan, input.stagingRoot)
    const coordinator = makeWorkspaceMigrationCoordinator({
      persistence: input.manifestStore,
      nowIso: input.nowIso,
    })

    if (durable.phase === 'VERIFIED') {
      if (!artifactsMatch({ plan: input.plan, fs: input.fs, ...paths })) {
        throw new WorkspaceRegistryMigrationPreparationError('ARTIFACT_VERIFICATION_FAILED')
      }
      return { manifest: durable }
    }
    if (durable.phase !== 'PREPARED' && durable.phase !== 'COPIED') {
      throw new WorkspaceRegistryMigrationPreparationError('PHASE_NOT_PREPARABLE')
    }

    if (durable.phase === 'PREPARED') {
      const backup = input.fs.readFile(paths.backupPath)
      if (backup === undefined) {
        input.fs.writeFileExclusive(paths.backupPath, input.plan.backupBytes)
      } else if (backup !== input.plan.backupBytes) {
        throw new WorkspaceRegistryMigrationPreparationError('ARTIFACT_VERIFICATION_FAILED')
      }
      input.fs.syncFile(paths.backupPath)

      const candidate = input.fs.readFile(paths.candidatePath)
      if (candidate === undefined) {
        input.fs.writeFileExclusive(paths.candidatePath, input.plan.candidateBytes)
      } else if (candidate !== input.plan.candidateBytes) {
        throw new WorkspaceRegistryMigrationPreparationError('ARTIFACT_VERIFICATION_FAILED')
      }
      input.fs.syncFile(paths.candidatePath)
      input.fs.syncDirectory(paths.runDirectory)
      assertHeld(input.lock, token)
      coordinator.advance('PREPARED', 'COPIED')
    }

    if (!artifactsMatch({ plan: input.plan, fs: input.fs, ...paths })) {
      throw new WorkspaceRegistryMigrationPreparationError('ARTIFACT_VERIFICATION_FAILED')
    }
    assertHeld(input.lock, token)
    return { manifest: coordinator.advance('COPIED', 'VERIFIED') }
  } finally {
    if (input.lock.isHeld(token)) input.lock.release(token)
  }
}

/**
 * Revalidates an already prepared registry bundle without taking the migration
 * lock or changing durable state. Activation must repeat this check while
 * holding the exclusive lock so this advisory result cannot become a TOCTOU
 * authority boundary.
 */
export function verifyWorkspaceRegistryMigrationBundle(input: {
  plan: WorkspaceRegistryMigrationPlan
  sourceRegistryPath: string
  stagingRoot: string
  manifestStore: WorkspaceMigrationManifestPersistencePort
  fs: Pick<WorkspaceRegistryMigrationPreparationFs, 'readFile'>
}): { manifest: WorkspaceMigrationManifest } {
  const durable = input.manifestStore.load()
  if (!samePlanManifest(durable, input.plan.manifest)) {
    throw new WorkspaceRegistryMigrationPreparationError('MANIFEST_MISMATCH')
  }
  const paths = validateStagingPaths(input.plan, input.stagingRoot)
  if (!artifactsMatch({ plan: input.plan, fs: input.fs, ...paths })) {
    throw new WorkspaceRegistryMigrationPreparationError('ARTIFACT_VERIFICATION_FAILED')
  }
  if (durable.phase !== 'VERIFIED' && durable.phase !== 'COMMITTED' &&
    durable.phase !== 'V2_WRITES_ENABLED') {
    throw new WorkspaceRegistryMigrationPreparationError('PHASE_NOT_PREPARABLE')
  }
  const expectedLiveBytes = durable.phase === 'VERIFIED'
    ? input.plan.backupBytes
    : durable.phase === 'COMMITTED'
      ? input.plan.candidateBytes
      : null
  if (expectedLiveBytes !== null &&
    input.fs.readFile(input.sourceRegistryPath) !== expectedLiveBytes) {
    throw new WorkspaceRegistryMigrationPreparationError('SOURCE_CHANGED')
  }
  return { manifest: durable }
}

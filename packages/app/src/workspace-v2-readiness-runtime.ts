import {
  evaluateWorkspaceV2Readiness,
  memoryMigrationManifestPath,
  validateLegacyMemoryMigrationManifest,
  validateWorkspaceMigrationManifest,
  verifyLegacyMemoryMigrationBundle,
  verifyMigrationCohort,
  type LegacyMemoryMigrationPhase,
  type WorkspaceMigrationManifest,
  type WorkspaceMigrationManifestPersistencePort,
  type WorkspaceMigrationPhase,
  type WorkspaceRegistryMigrationPlan,
  type WorkspaceV2ReadinessEvidence,
  type WorkspaceV2ReadinessReport,
} from '@aisy/core'
import { verifyWorkspaceRegistryMigrationBundle } from './workspace-registry-migration-preparer.js'

type RegistryEvidence = WorkspaceV2ReadinessEvidence['registry']
type MemoryEvidence = WorkspaceV2ReadinessEvidence['memory']
type ReadinessCheck = () => boolean

export interface WorkspaceRegistryBundleInspectorInput {
  plan: WorkspaceRegistryMigrationPlan
  sourceRegistryPath: string
  manifestPath: string
  stagingRoot: string
  exists(path: string): boolean
  manifestStore: WorkspaceMigrationManifestPersistencePort
  fs: { readFile(path: string): string | undefined }
}

export interface LegacyMemoryBundleInspectorInput {
  sourceDbPath: string
  /** Staging root of the cohort; the manifest path is derived from it, never scanned (ADR-0070). */
  stagingRoot: string
  /** Registry manifest of the cohort this memory run must belong to. */
  registryManifest: WorkspaceMigrationManifest
  exists(path: string): boolean
  readFile(path: string): string
}

/** Converts registry artifact verification into fail-closed readiness evidence. */
export function inspectWorkspaceRegistryMigrationBundle(
  input: WorkspaceRegistryBundleInspectorInput,
): RegistryEvidence {
  if (!input.exists(input.manifestPath)) return { phase: null, bundleVerified: false }
  let phase: WorkspaceMigrationPhase = 'PREPARED'
  try {
    phase = input.manifestStore.load().phase
  } catch {
    return { phase, bundleVerified: false }
  }
  try {
    verifyWorkspaceRegistryMigrationBundle(input)
    return { phase, bundleVerified: true }
  } catch {
    return { phase, bundleVerified: false }
  }
}

/** Converts the core Node/SQLite verifier into fail-closed readiness evidence. */
export function inspectLegacyMemoryMigrationBundle(
  input: LegacyMemoryBundleInspectorInput,
): MemoryEvidence {
  // The manifest location is derived from the cohort, so a stray or newer manifest
  // sitting in the staging root is simply not looked at (ADR-0070).
  let manifestPath: string
  try {
    manifestPath = memoryMigrationManifestPath(input.stagingRoot, input.registryManifest.migrationId)
  } catch {
    return { phase: null, bundleVerified: false }
  }
  if (!input.exists(manifestPath)) return { phase: null, bundleVerified: false }
  let phase: LegacyMemoryMigrationPhase = 'PREPARED'
  let expectedCohort: { registryMigrationId: string; sourceRegistrySha256: string }
  try {
    // The registry manifest is authority here, so it is validated rather than trusted.
    const registryManifest = validateWorkspaceMigrationManifest(input.registryManifest)
    const manifest = validateLegacyMemoryMigrationManifest(
      JSON.parse(input.readFile(manifestPath)),
      manifestPath,
    )
    phase = manifest.phase
    const cohort = verifyMigrationCohort({
      registry: registryManifest,
      memory: manifest,
      stagingRoot: input.stagingRoot,
      manifestPath,
    })
    if (!cohort.ok) return { phase, bundleVerified: false }
    expectedCohort = { ...manifest.cohort }
  } catch {
    return { phase, bundleVerified: false }
  }
  try {
    // The verifier re-reads the manifest from disk; pass the cohort we just proved so
    // a file swapped between the two reads cannot pass as a verified bundle.
    verifyLegacyMemoryMigrationBundle({
      sourceDbPath: input.sourceDbPath,
      manifestPath,
      expectedCohort,
    })
    return { phase, bundleVerified: true }
  } catch {
    return { phase, bundleVerified: false }
  }
}

function checked(check: ReadinessCheck): boolean {
  try {
    return check() === true
  } catch {
    return false
  }
}

/**
 * Composes read-only inspectors into the doctor probe. This result is advisory:
 * the eventual activation path must revalidate under the exclusive lock.
 */
export function makeWorkspaceV2ReadinessProbe(input: {
  registry: () => RegistryEvidence
  memory: () => MemoryEvidence
  runtime: {
    registry: ReadinessCheck
    scopedMemory: ReadinessCheck
    layeredContext: ReadinessCheck
    transcript: ReadinessCheck
    confinement: ReadinessCheck
  }
  rollback: {
    exclusiveLockAvailable: ReadinessCheck
    dryRunVerified: ReadinessCheck
  }
}): { workspaceV2(): WorkspaceV2ReadinessReport } {
  return {
    workspaceV2() {
      let registry: RegistryEvidence = { phase: 'PREPARED', bundleVerified: false }
      let memory: MemoryEvidence = { phase: 'PREPARED', bundleVerified: false }
      try { registry = input.registry() } catch { /* fail closed */ }
      try { memory = input.memory() } catch { /* fail closed */ }
      return evaluateWorkspaceV2Readiness({
        registry,
        memory,
        runtime: {
          registry: checked(input.runtime.registry),
          scopedMemory: checked(input.runtime.scopedMemory),
          layeredContext: checked(input.runtime.layeredContext),
          transcript: checked(input.runtime.transcript),
          confinement: checked(input.runtime.confinement),
        },
        rollback: {
          exclusiveLockAvailable: checked(input.rollback.exclusiveLockAvailable),
          backupVerified: registry.bundleVerified && memory.bundleVerified,
          dryRunVerified: checked(input.rollback.dryRunVerified),
        },
      })
    },
  }
}

// Production doctor composition for Workspace v2 readiness (ADR-0073).
//
// Read-only by construction: it re-plans the migration from the current v1
// registry purely to re-derive expected artifacts, never writes, never advances a
// phase, and never turns v2 writes on. An absent manifest is reported as
// "not prepared", not as a failure.

import {
  evaluateWorkspaceV2Readiness,
  memoryMigrationManifestPath,
  planWorkspaceRegistryV1Migration,
  validateWorkspaceMigrationManifest,
  type ProjectRegistryV2Policy,
  type LegacyRegistryOwner,
  type WorkspaceMigrationManifest,
  type WorkspaceV2ReadinessReport,
} from '@aisy/core'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  inspectLegacyMemoryMigrationBundle,
  inspectWorkspaceRegistryMigrationBundle,
} from './workspace-v2-readiness-runtime.js'
import { makeRollbackRehearsalStore } from './workspace-v2-rollback-rehearsal.js'

export interface WorkspaceV2DoctorInput {
  home: string
  sourceRegistryPath: string
  sourceDbPath: string
  owners: readonly LegacyRegistryOwner[]
  policy: ProjectRegistryV2Policy
  nowIso?: () => string
  newId?: () => string
}

const NOT_PREPARED: WorkspaceV2ReadinessReport = {
  state: 'not-prepared',
  ok: true,
  readyForActivation: false,
  activationRequiresApproval: true,
  rollbackMode: 'rollback-or-resume',
  issues: [],
}

/** Установка выросла сразу на v2: переносить нечего и никогда не будет. */
const NOT_REQUIRED: WorkspaceV2ReadinessReport = { ...NOT_PREPARED, state: 'not-required' }

/**
 * Compose the real readiness verdict for `aisy doctor`. Every failure degrades to
 * fail-closed evidence rather than an exception, so the probe cannot take the
 * doctor down with it.
 */
export function makeWorkspaceV2DoctorProbe(input: WorkspaceV2DoctorInput): {
  workspaceV2(): WorkspaceV2ReadinessReport
} {
  const migrationsRoot = join(input.home, 'migrations')
  const manifestPath = join(migrationsRoot, 'workspace-v2.json')
  const stagingRoot = join(migrationsRoot, 'staging')
  const rehearsals = makeRollbackRehearsalStore({ path: join(migrationsRoot, 'rehearsals.json') })

  return {
    workspaceV2(): WorkspaceV2ReadinessReport {
      // Реестра v1 нет и подготовленной миграции тоже — значит установка
      // родилась на v2. Отдельный вердикт вместо «не подготовлена»: последнее
      // читается как незакрытый долг, которого здесь не существует.
      if (!existsSync(manifestPath)) {
        return existsSync(input.sourceRegistryPath) ? NOT_PREPARED : NOT_REQUIRED
      }

      let durable: WorkspaceMigrationManifest
      try {
        durable = validateWorkspaceMigrationManifest(
          JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspaceMigrationManifest,
        )
      } catch {
        // A manifest that exists but cannot be read is never "not prepared".
        return evaluateWorkspaceV2Readiness({
          registry: { phase: 'PREPARED', bundleVerified: false },
          memory: { phase: 'PREPARED', bundleVerified: false },
          runtime: {
            registry: false, scopedMemory: false, layeredContext: false,
            transcript: false, confinement: false,
          },
          rollback: { exclusiveLockAvailable: false, backupVerified: false, dryRunVerified: false },
        })
      }

      const registry = (() => {
        try {
          const plan = planWorkspaceRegistryV1Migration({
            sourceBytes: readFileSync(input.sourceRegistryPath, 'utf8'),
            owners: [...input.owners],
            policy: input.policy,
            stagingRoot,
            migrationId: durable.migrationId,
            nowIso: input.nowIso ?? (() => new Date().toISOString()),
            newId: input.newId ?? (() => 'doctor'),
          })
          return inspectWorkspaceRegistryMigrationBundle({
            plan,
            sourceRegistryPath: input.sourceRegistryPath,
            manifestPath,
            stagingRoot,
            exists: path => existsSync(path),
            manifestStore: {
              load: () => durable,
              saveAtomic: () => { throw new Error('READ_ONLY_DOCTOR_WROTE') },
            },
            fs: {
              readFile: path => existsSync(path) ? readFileSync(path, 'utf8') : undefined,
            },
          })
        } catch {
          return { phase: durable.phase, bundleVerified: false }
        }
      })()

      const memory = (() => {
        try {
          return inspectLegacyMemoryMigrationBundle({
            sourceDbPath: input.sourceDbPath,
            stagingRoot,
            registryManifest: durable,
            exists: path => existsSync(path),
            readFile: path => readFileSync(path, 'utf8'),
          })
        } catch {
          return { phase: null, bundleVerified: false }
        }
      })()

      // A rehearsal is evidence only when it belongs to this cohort (ADR-0073).
      const rehearsal = (() => {
        try { return rehearsals.load(durable.migrationId) } catch { return null }
      })()

      return evaluateWorkspaceV2Readiness({
        registry,
        memory,
        runtime: {
          registry: registry.bundleVerified,
          scopedMemory: memory.bundleVerified,
          layeredContext: memory.bundleVerified,
          transcript: registry.bundleVerified,
          confinement: registry.bundleVerified,
        },
        rollback: {
          // The doctor never holds the migration lock; it reports whether one
          // could be taken, which is exactly "no live writer is holding it".
          exclusiveLockAvailable: !existsSync(join(migrationsRoot, 'migration.lock')),
          backupVerified: registry.bundleVerified && memory.bundleVerified,
          dryRunVerified: rehearsal !== null,
        },
      })
    },
  }
}

/** Where the doctor and the activation path agree the memory manifest lives. */
export function workspaceV2MemoryManifestPath(home: string, cohortId: string): string {
  return memoryMigrationManifestPath(join(home, 'migrations', 'staging'), cohortId)
}

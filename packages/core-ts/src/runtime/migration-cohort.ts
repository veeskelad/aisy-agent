// Migration cohort binding (ADR-0070).
// Two independent migrations — project registry and protected memory — only count
// as one migration when they name the same cohort. Equal phases prove nothing, and
// a manifest found by directory scan or mtime is never authority.

import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import type { LegacyMemoryMigrationManifest, LegacyMemoryMigrationPhase } from './legacy-memory-migration.js'
import type { WorkspaceMigrationManifest, WorkspaceMigrationPhase } from './project-registry-v2.js'

export type MigrationCohortRefusal =
  | 'cohort-missing'
  | 'cohort-mismatch'
  | 'registry-source-mismatch'
  | 'manifest-path-mismatch'

export type MigrationCohortVerdict =
  | { ok: true; cohortId: string; bothMigrationsTerminal: boolean }
  | { ok: false; reason: MigrationCohortRefusal }

const SHA256 = /^[0-9a-f]{64}$/
const TERMINAL_REGISTRY: ReadonlySet<WorkspaceMigrationPhase> = new Set<WorkspaceMigrationPhase>([
  'COMMITTED',
  'V2_WRITES_ENABLED',
])
const TERMINAL_MEMORY: LegacyMemoryMigrationPhase = 'VERIFIED'

/** The only accepted location of a cohort's memory manifest — derived, never discovered. */
export function memoryMigrationManifestPath(stagingRoot: string, cohortId: string): string {
  if (typeof stagingRoot !== 'string' || !isAbsolute(stagingRoot) ||
    typeof cohortId !== 'string' || cohortId === '') {
    // A relative staging root would anchor the cohort to `process.cwd()`.
    throw new Error('migration cohort: absolute stagingRoot and non-empty cohortId are required')
  }
  return resolve(stagingRoot, `memory-${createHash('sha256').update(cohortId).digest('hex').slice(0, 32)}.json`)
}

/**
 * Verify that a registry manifest and a memory manifest belong to one cohort.
 *
 * `manifestPath` must equal the path derived from the cohort — that is what stops a
 * scanned or mtime-picked manifest from being accepted. Both path inputs are
 * mandatory: an optional check would silently pass when a caller forgets it.
 */
export function verifyMigrationCohort(input: {
  registry: WorkspaceMigrationManifest
  memory: LegacyMemoryMigrationManifest
  /** Absolute staging root of the cohort. Required: an optional path check is a fail-open default. */
  stagingRoot: string
  /** Where the memory manifest was actually read from; must equal the derived path. */
  manifestPath: string
}): MigrationCohortVerdict {
  // Read every authority field exactly once, as an own property: an accessor must
  // not answer one value to the check and another to the caller, and an inherited
  // `cohort` from a polluted prototype must not count as a binding at all.
  const own = <T>(source: unknown, key: string): T | undefined =>
    typeof source === 'object' && source !== null && Object.hasOwn(source, key)
      ? (source as Record<string, T>)[key]
      : undefined

  const cohort = own<Record<string, unknown>>(input.memory, 'cohort')
  const cohortRegistryId = own<unknown>(cohort, 'registryMigrationId')
  const cohortSourceSha = own<unknown>(cohort, 'sourceRegistrySha256')
  if (typeof cohort !== 'object' || cohort === null ||
    typeof cohortRegistryId !== 'string' || cohortRegistryId === '' ||
    typeof cohortSourceSha !== 'string' || !SHA256.test(cohortSourceSha)) {
    return { ok: false, reason: 'cohort-missing' }
  }

  const registryId = own<unknown>(input.registry, 'migrationId')
  const memoryId = own<unknown>(input.memory, 'migrationId')
  if (typeof registryId !== 'string' || registryId === '' ||
    cohortRegistryId !== registryId || memoryId !== registryId) {
    return { ok: false, reason: 'cohort-mismatch' }
  }

  // A re-prepared registry keeps its id but changes its source hash; that is a
  // different migration of the same name and must not bind to the old memory run.
  if (cohortSourceSha !== own<unknown>(input.registry, 'sourceRegistrySha256')) {
    return { ok: false, reason: 'registry-source-mismatch' }
  }

  let derived: string
  try {
    derived = memoryMigrationManifestPath(input.stagingRoot, registryId)
  } catch {
    return { ok: false, reason: 'manifest-path-mismatch' }
  }
  if (input.manifestPath !== derived) return { ok: false, reason: 'manifest-path-mismatch' }

  const registryPhase = own<WorkspaceMigrationPhase>(input.registry, 'phase')
  const memoryPhase = own<LegacyMemoryMigrationPhase>(input.memory, 'phase')
  return {
    ok: true,
    cohortId: registryId,
    // NOT an activation verdict on its own: it only states that both migrations
    // reached a terminal phase. The activation gate must additionally satisfy the
    // rollback rehearsal and runtime checks of `evaluateWorkspaceV2Readiness`.
    bothMigrationsTerminal: registryPhase !== undefined && TERMINAL_REGISTRY.has(registryPhase) &&
      memoryPhase === TERMINAL_MEMORY,
  }
}

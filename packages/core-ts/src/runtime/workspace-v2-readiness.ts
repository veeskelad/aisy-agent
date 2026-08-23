import type { LegacyMemoryMigrationPhase } from './legacy-memory-migration.js'
import type { WorkspaceMigrationPhase } from './project-registry-v2.js'

export type WorkspaceV2ReadinessState =
  /**
   * Мигрировать нечего: реестра v1 на этой установке нет вовсе.
   *
   * Отличается от `not-prepared` тем, что там миграция ещё предстоит, а здесь
   * её не будет никогда. Установка, выросшая сразу на v2, иначе вечно читает
   * про «v1 остаётся authoritative» — про файл, которого у неё нет.
   */
  | 'not-required'
  | 'not-prepared'
  | 'maintenance-incomplete'
  | 'not-ready'
  | 'ready-for-approval'
  | 'committed-awaiting-enable'
  | 'active-forward-repair'

export type WorkspaceV2ReadinessIssue =
  | 'REGISTRY_MANIFEST_MISSING'
  | 'MEMORY_MANIFEST_MISSING'
  | 'REGISTRY_PHASE_INCOMPLETE'
  | 'MEMORY_PHASE_INCOMPLETE'
  | 'REGISTRY_BUNDLE_UNVERIFIED'
  | 'MEMORY_BUNDLE_UNVERIFIED'
  | 'EXCLUSIVE_LOCK_UNAVAILABLE'
  | 'ROLLBACK_BACKUP_UNVERIFIED'
  | 'ROLLBACK_DRY_RUN_UNVERIFIED'
  | 'RUNTIME_REGISTRY_UNVERIFIED'
  | 'RUNTIME_SCOPED_MEMORY_UNVERIFIED'
  | 'RUNTIME_LAYERED_CONTEXT_UNVERIFIED'
  | 'RUNTIME_TRANSCRIPT_UNVERIFIED'
  | 'RUNTIME_CONFINEMENT_UNVERIFIED'

export interface WorkspaceV2ReadinessEvidence {
  registry: {
    phase: WorkspaceMigrationPhase | null
    bundleVerified: boolean
  }
  memory: {
    phase: LegacyMemoryMigrationPhase | null
    bundleVerified: boolean
  }
  runtime: {
    registry: boolean
    scopedMemory: boolean
    layeredContext: boolean
    transcript: boolean
    confinement: boolean
  }
  rollback: {
    exclusiveLockAvailable: boolean
    backupVerified: boolean
    dryRunVerified: boolean
  }
}

export interface WorkspaceV2ReadinessReport {
  state: WorkspaceV2ReadinessState
  ok: boolean
  readyForActivation: boolean
  activationRequiresApproval: true
  rollbackMode: 'rollback-or-resume' | 'forward-repair'
  issues: WorkspaceV2ReadinessIssue[]
}

const REGISTRY_PHASES = new Set<WorkspaceMigrationPhase>([
  'PREPARED', 'COPIED', 'VERIFIED', 'COMMITTED', 'V2_WRITES_ENABLED',
])
const MEMORY_PHASES = new Set<LegacyMemoryMigrationPhase>(['PREPARED', 'COPIED', 'VERIFIED'])

function assertEvidence(input: WorkspaceV2ReadinessEvidence): void {
  if ((input.registry.phase !== null && !REGISTRY_PHASES.has(input.registry.phase)) ||
    (input.memory.phase !== null && !MEMORY_PHASES.has(input.memory.phase))) {
    throw new Error('INVALID_WORKSPACE_V2_READINESS_EVIDENCE')
  }
}

/** Pure readiness gate. It never advances a manifest or performs activation. */
export function evaluateWorkspaceV2Readiness(
  input: WorkspaceV2ReadinessEvidence,
): WorkspaceV2ReadinessReport {
  assertEvidence(input)
  const issues: WorkspaceV2ReadinessIssue[] = []
  if (input.registry.phase === null) issues.push('REGISTRY_MANIFEST_MISSING')
  if (input.memory.phase === null) issues.push('MEMORY_MANIFEST_MISSING')

  const bothMissing = input.registry.phase === null && input.memory.phase === null
  const forwardRepair = input.registry.phase === 'V2_WRITES_ENABLED'
  if (input.registry.phase === 'PREPARED' || input.registry.phase === 'COPIED') {
    issues.push('REGISTRY_PHASE_INCOMPLETE')
  }
  if (input.memory.phase === 'PREPARED' || input.memory.phase === 'COPIED') {
    issues.push('MEMORY_PHASE_INCOMPLETE')
  }
  if (input.registry.phase !== null && !input.registry.bundleVerified) {
    issues.push('REGISTRY_BUNDLE_UNVERIFIED')
  }
  if (input.memory.phase !== null && !input.memory.bundleVerified) {
    issues.push('MEMORY_BUNDLE_UNVERIFIED')
  }

  const runtimeChecks = [
    ['registry', 'RUNTIME_REGISTRY_UNVERIFIED'],
    ['scopedMemory', 'RUNTIME_SCOPED_MEMORY_UNVERIFIED'],
    ['layeredContext', 'RUNTIME_LAYERED_CONTEXT_UNVERIFIED'],
    ['transcript', 'RUNTIME_TRANSCRIPT_UNVERIFIED'],
    ['confinement', 'RUNTIME_CONFINEMENT_UNVERIFIED'],
  ] as const
  if (!bothMissing) {
    for (const [key, issue] of runtimeChecks) {
      if (!input.runtime[key]) issues.push(issue)
    }
  }

  if (!bothMissing && !forwardRepair) {
    if (!input.rollback.exclusiveLockAvailable) issues.push('EXCLUSIVE_LOCK_UNAVAILABLE')
    if (!input.rollback.backupVerified) issues.push('ROLLBACK_BACKUP_UNVERIFIED')
    if (!input.rollback.dryRunVerified) issues.push('ROLLBACK_DRY_RUN_UNVERIFIED')
  }
  issues.sort()

  let state: WorkspaceV2ReadinessState
  if (bothMissing) state = 'not-prepared'
  else if (forwardRepair) state = 'active-forward-repair'
  else if (input.registry.phase === 'PREPARED' || input.registry.phase === 'COPIED' ||
    input.memory.phase === 'PREPARED' || input.memory.phase === 'COPIED') {
    state = 'maintenance-incomplete'
  } else if (issues.length > 0) state = 'not-ready'
  else if (input.registry.phase === 'COMMITTED') state = 'committed-awaiting-enable'
  else state = 'ready-for-approval'

  const readyForActivation = issues.length === 0 &&
    (state === 'ready-for-approval' || state === 'committed-awaiting-enable')
  const ok = state === 'not-prepared' || readyForActivation ||
    (state === 'active-forward-repair' && issues.length === 0)
  return {
    state,
    ok,
    readyForActivation,
    activationRequiresApproval: true,
    rollbackMode: forwardRepair ? 'forward-repair' : 'rollback-or-resume',
    issues,
  }
}

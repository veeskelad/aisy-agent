// Activation authority for the irreversible Workspace v2 cutover (ADR-0073).
//
// This module grants a right, it never performs the transition: publication stays
// with the caller, under the same exclusive lock. Every authority field is read
// once as an own property — a value that was validated must be the value used.

import { createHash } from 'node:crypto'

import type { MigrationCohortVerdict } from './migration-cohort.js'
import type { WorkspaceMigrationPhase } from './project-registry-v2.js'
import type { WorkspaceV2ReadinessReport } from './workspace-v2-readiness.js'

export type WorkspaceV2ActivationRefusal =
  | 'not-ready'
  | 'phase-not-committed'
  | 'already-activated'
  | 'cohort-unbound'
  | 'rehearsal-missing'
  | 'approval-mismatch'
  | 'approval-already-used'

export type WorkspaceV2ActivationVerdict =
  | { ok: true; cohortId: string; from: 'COMMITTED'; to: 'V2_WRITES_ENABLED'; evidenceHash: string }
  | { ok: false; reason: WorkspaceV2ActivationRefusal }

/** Durable proof that a restore from backup was actually performed for this cohort. */
export interface WorkspaceV2RollbackRehearsal {
  rehearsalId: string
  cohortId: string
  performedAt: string
  restoredRegistrySha256: string
  restoredMemoryLedgerSha256: string
  verdict: 'passed'
}

/** Operator approval bound to one cohort and one exact evidence state. */
export interface WorkspaceV2ActivationApproval {
  cohortId: string
  evidenceHash: string
  approvedBy: string
  approvedAt: string
}

const SHA256 = /^[0-9a-f]{64}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function own<T>(source: unknown, key: string): T | undefined {
  return typeof source === 'object' && source !== null && Object.hasOwn(source, key)
    ? (source as Record<string, T>)[key]
    : undefined
}

function instant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value))
}

/**
 * Canonical hash of everything the approval is answering for. Any drift between
 * issuing and applying the approval changes this value and closes activation.
 */
export function workspaceV2ActivationEvidenceHash(input: {
  report: WorkspaceV2ReadinessReport
  cohortId: string
  registryPhase: WorkspaceMigrationPhase
  memoryPhase: string
  sourceRegistrySha256: string
  rehearsalId: string
}): string {
  const canonical = JSON.stringify([
    'aisy.workspace-v2.activation.v1',
    input.cohortId,
    input.registryPhase,
    input.memoryPhase,
    input.sourceRegistrySha256,
    input.rehearsalId,
    input.report.state,
    input.report.readyForActivation,
    input.report.rollbackMode,
    [...input.report.issues].sort(),
  ])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export interface WorkspaceV2ActivationInput {
  report: WorkspaceV2ReadinessReport
  cohort: MigrationCohortVerdict
  registryPhase: WorkspaceMigrationPhase
  memoryPhase: string
  sourceRegistrySha256: string
  rehearsal: WorkspaceV2RollbackRehearsal | null
  approval: WorkspaceV2ActivationApproval
  /** Approvals already spent; activation happens exactly once. */
  usedApprovals?: ReadonlySet<string>
}

/**
 * Decide whether the irreversible cutover may proceed. Returns the single
 * permitted transition, never performs it, and never leaks paths or manifest
 * contents in a refusal.
 */
export function authorizeWorkspaceV2Activation(
  input: WorkspaceV2ActivationInput,
): WorkspaceV2ActivationVerdict {
  const registryPhase = input.registryPhase
  if (registryPhase === 'V2_WRITES_ENABLED') return { ok: false, reason: 'already-activated' }
  if (registryPhase !== 'COMMITTED') return { ok: false, reason: 'phase-not-committed' }

  const report = input.report
  if (typeof report !== 'object' || report === null ||
    report.readyForActivation !== true || report.state !== 'committed-awaiting-enable' ||
    !Array.isArray(report.issues) || report.issues.length > 0) {
    return { ok: false, reason: 'not-ready' }
  }

  const cohort = input.cohort
  if (typeof cohort !== 'object' || cohort === null || cohort.ok !== true ||
    cohort.bothMigrationsTerminal !== true || typeof cohort.cohortId !== 'string' ||
    !ID.test(cohort.cohortId)) {
    return { ok: false, reason: 'cohort-unbound' }
  }
  const cohortId = cohort.cohortId

  const rehearsal = input.rehearsal
  const rehearsalId = own<unknown>(rehearsal, 'rehearsalId')
  if (rehearsal === null || typeof rehearsal !== 'object' ||
    own<unknown>(rehearsal, 'verdict') !== 'passed' ||
    own<unknown>(rehearsal, 'cohortId') !== cohortId ||
    typeof rehearsalId !== 'string' || !ID.test(rehearsalId) ||
    !instant(own<unknown>(rehearsal, 'performedAt')) ||
    !SHA256.test(String(own<unknown>(rehearsal, 'restoredRegistrySha256'))) ||
    !SHA256.test(String(own<unknown>(rehearsal, 'restoredMemoryLedgerSha256')))) {
    return { ok: false, reason: 'rehearsal-missing' }
  }

  if (!SHA256.test(input.sourceRegistrySha256)) return { ok: false, reason: 'cohort-unbound' }

  const expected = workspaceV2ActivationEvidenceHash({
    report,
    cohortId,
    registryPhase,
    memoryPhase: input.memoryPhase,
    sourceRegistrySha256: input.sourceRegistrySha256,
    rehearsalId,
  })

  const approval = input.approval
  const approvedBy = own<unknown>(approval, 'approvedBy')
  const approvedAt = own<unknown>(approval, 'approvedAt')
  if (typeof approval !== 'object' || approval === null ||
    own<unknown>(approval, 'cohortId') !== cohortId ||
    own<unknown>(approval, 'evidenceHash') !== expected ||
    typeof approvedBy !== 'string' || approvedBy.trim() === '' || approvedBy.length > 256 ||
    !instant(approvedAt)) {
    return { ok: false, reason: 'approval-mismatch' }
  }

  const spent = `${cohortId} ${expected} ${approvedBy} ${approvedAt}`
  if (input.usedApprovals?.has(spent) === true) {
    return { ok: false, reason: 'approval-already-used' }
  }

  return { ok: true, cohortId, from: 'COMMITTED', to: 'V2_WRITES_ENABLED', evidenceHash: expected }
}

/** Stable key of a spent approval; the caller persists these to keep cutover single-shot. */
export function workspaceV2ActivationApprovalKey(approval: WorkspaceV2ActivationApproval): string {
  return `${approval.cohortId} ${approval.evidenceHash} ${approval.approvedBy} ${approval.approvedAt}`
}

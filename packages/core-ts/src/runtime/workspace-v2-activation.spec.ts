import { describe, expect, it } from 'vitest'

import {
  authorizeWorkspaceV2Activation,
  workspaceV2ActivationApprovalKey,
  workspaceV2ActivationEvidenceHash,
  type WorkspaceV2ActivationApproval,
  type WorkspaceV2ActivationInput,
  type WorkspaceV2RollbackRehearsal,
} from './workspace-v2-activation.js'
import type { WorkspaceV2ReadinessReport } from './workspace-v2-readiness.js'

const COHORT = 'migration-2026-07-29'
const SOURCE_SHA = 'a'.repeat(64)

const report = (overrides: Partial<WorkspaceV2ReadinessReport> = {}): WorkspaceV2ReadinessReport => ({
  state: 'committed-awaiting-enable',
  ok: true,
  readyForActivation: true,
  activationRequiresApproval: true,
  rollbackMode: 'rollback-or-resume',
  issues: [],
  ...overrides,
})

const rehearsal = (overrides: Partial<WorkspaceV2RollbackRehearsal> = {}): WorkspaceV2RollbackRehearsal => ({
  rehearsalId: 'rehearsal-1',
  cohortId: COHORT,
  performedAt: '2026-07-29T09:00:00Z',
  restoredRegistrySha256: 'b'.repeat(64),
  restoredMemoryLedgerSha256: 'c'.repeat(64),
  verdict: 'passed',
  ...overrides,
})

function evidenceHash(overrides: { report?: WorkspaceV2ReadinessReport; rehearsalId?: string } = {}): string {
  return workspaceV2ActivationEvidenceHash({
    report: overrides.report ?? report(),
    cohortId: COHORT,
    registryPhase: 'COMMITTED',
    memoryPhase: 'VERIFIED',
    sourceRegistrySha256: SOURCE_SHA,
    rehearsalId: overrides.rehearsalId ?? 'rehearsal-1',
  })
}

function approval(overrides: Partial<WorkspaceV2ActivationApproval> = {}): WorkspaceV2ActivationApproval {
  return {
    cohortId: COHORT,
    evidenceHash: evidenceHash(),
    approvedBy: 'operator',
    approvedAt: '2026-07-29T10:00:00Z',
    ...overrides,
  }
}

function input(overrides: Partial<WorkspaceV2ActivationInput> = {}): WorkspaceV2ActivationInput {
  return {
    report: report(),
    cohort: { ok: true, cohortId: COHORT, bothMigrationsTerminal: true },
    registryPhase: 'COMMITTED',
    memoryPhase: 'VERIFIED',
    sourceRegistrySha256: SOURCE_SHA,
    rehearsal: rehearsal(),
    approval: approval(),
    ...overrides,
  }
}

describe('workspace v2 activation authority (ADR-0073)', () => {
  it('grants exactly one transition when every proof is present', () => {
    expect(authorizeWorkspaceV2Activation(input())).toEqual({
      ok: true,
      cohortId: COHORT,
      from: 'COMMITTED',
      to: 'V2_WRITES_ENABLED',
      evidenceHash: evidenceHash(),
    })
  })

  it('refuses any phase other than COMMITTED and never repeats an activation', () => {
    expect(authorizeWorkspaceV2Activation(input({ registryPhase: 'VERIFIED' })))
      .toEqual({ ok: false, reason: 'phase-not-committed' })
    expect(authorizeWorkspaceV2Activation(input({ registryPhase: 'PREPARED' })))
      .toEqual({ ok: false, reason: 'phase-not-committed' })
    expect(authorizeWorkspaceV2Activation(input({ registryPhase: 'V2_WRITES_ENABLED' })))
      .toEqual({ ok: false, reason: 'already-activated' })
  })

  it('refuses a readiness report that is not a clean committed-awaiting-enable', () => {
    expect(authorizeWorkspaceV2Activation(input({ report: report({ readyForActivation: false }) })))
      .toEqual({ ok: false, reason: 'not-ready' })
    expect(authorizeWorkspaceV2Activation(input({ report: report({ state: 'ready-for-approval' }) })))
      .toEqual({ ok: false, reason: 'not-ready' })
    expect(authorizeWorkspaceV2Activation(input({
      report: report({ issues: ['ROLLBACK_DRY_RUN_UNVERIFIED'] }),
    }))).toEqual({ ok: false, reason: 'not-ready' })
  })

  it('refuses an unbound cohort or one whose migrations are not both terminal', () => {
    expect(authorizeWorkspaceV2Activation(input({ cohort: { ok: false, reason: 'cohort-mismatch' } })))
      .toEqual({ ok: false, reason: 'cohort-unbound' })
    expect(authorizeWorkspaceV2Activation(input({
      cohort: { ok: true, cohortId: COHORT, bothMigrationsTerminal: false },
    }))).toEqual({ ok: false, reason: 'cohort-unbound' })
  })

  it('treats a missing, foreign or failed rehearsal as no rehearsal at all', () => {
    expect(authorizeWorkspaceV2Activation(input({ rehearsal: null })))
      .toEqual({ ok: false, reason: 'rehearsal-missing' })
    expect(authorizeWorkspaceV2Activation(input({ rehearsal: rehearsal({ cohortId: 'other' }) })))
      .toEqual({ ok: false, reason: 'rehearsal-missing' })
    expect(authorizeWorkspaceV2Activation(input({
      rehearsal: rehearsal({ verdict: 'failed' as never }),
    }))).toEqual({ ok: false, reason: 'rehearsal-missing' })
    expect(authorizeWorkspaceV2Activation(input({
      rehearsal: rehearsal({ restoredRegistrySha256: 'not-a-hash' }),
    }))).toEqual({ ok: false, reason: 'rehearsal-missing' })
  })

  it('refuses an approval issued for another cohort, state or rehearsal', () => {
    expect(authorizeWorkspaceV2Activation(input({ approval: approval({ cohortId: 'other' }) })))
      .toEqual({ ok: false, reason: 'approval-mismatch' })

    // Evidence drifted after the approval was issued: a different rehearsal id.
    expect(authorizeWorkspaceV2Activation(input({
      approval: approval({ evidenceHash: evidenceHash({ rehearsalId: 'rehearsal-0' }) }),
    }))).toEqual({ ok: false, reason: 'approval-mismatch' })

    expect(authorizeWorkspaceV2Activation(input({ approval: approval({ approvedBy: '  ' }) })))
      .toEqual({ ok: false, reason: 'approval-mismatch' })
    expect(authorizeWorkspaceV2Activation(input({ approval: approval({ approvedAt: '2026-13-45T99:99:99Z' }) })))
      .toEqual({ ok: false, reason: 'approval-mismatch' })
  })

  it('never spends the same approval twice', () => {
    const once = approval()
    const spent = new Set([workspaceV2ActivationApprovalKey(once)])

    expect(authorizeWorkspaceV2Activation(input({ approval: once })).ok).toBe(true)
    expect(authorizeWorkspaceV2Activation(input({ approval: once, usedApprovals: spent })))
      .toEqual({ ok: false, reason: 'approval-already-used' })
  })

  it('ignores inherited authority fields from a polluted prototype', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>
    proto.verdict = 'passed'
    proto.cohortId = COHORT
    try {
      expect(authorizeWorkspaceV2Activation(input({ rehearsal: {} as never })))
        .toEqual({ ok: false, reason: 'rehearsal-missing' })
    } finally {
      delete proto.verdict
      delete proto.cohortId
    }
  })

  it('changes the evidence hash when any part of the state changes', () => {
    const base = evidenceHash()
    expect(evidenceHash({ rehearsalId: 'rehearsal-2' })).not.toBe(base)
    expect(workspaceV2ActivationEvidenceHash({
      report: report(),
      cohortId: COHORT,
      registryPhase: 'COMMITTED',
      memoryPhase: 'COPIED',
      sourceRegistrySha256: SOURCE_SHA,
      rehearsalId: 'rehearsal-1',
    })).not.toBe(base)
    expect(workspaceV2ActivationEvidenceHash({
      report: report(),
      cohortId: COHORT,
      registryPhase: 'COMMITTED',
      memoryPhase: 'VERIFIED',
      sourceRegistrySha256: 'd'.repeat(64),
      rehearsalId: 'rehearsal-1',
    })).not.toBe(base)
  })

  it('returns only a stable code, never manifest content', () => {
    const verdict = authorizeWorkspaceV2Activation(input({ rehearsal: null }))
    expect(JSON.stringify(verdict)).toBe(JSON.stringify({ ok: false, reason: 'rehearsal-missing' }))
  })
})

import { describe, expect, it } from 'vitest'
import {
  evaluateWorkspaceV2Readiness,
  type WorkspaceV2ReadinessEvidence,
} from './workspace-v2-readiness.js'

function evidence(input: Partial<WorkspaceV2ReadinessEvidence> = {}): WorkspaceV2ReadinessEvidence {
  return {
    registry: { phase: 'VERIFIED', bundleVerified: true },
    memory: { phase: 'VERIFIED', bundleVerified: true },
    runtime: {
      registry: true,
      scopedMemory: true,
      layeredContext: true,
      transcript: true,
      confinement: true,
    },
    rollback: {
      exclusiveLockAvailable: true,
      backupVerified: true,
      dryRunVerified: true,
    },
    ...input,
  }
}

describe('evaluateWorkspaceV2Readiness', () => {
  it('reports a healthy v1 installation as not prepared without authorizing activation', () => {
    expect(evaluateWorkspaceV2Readiness(evidence({
      registry: { phase: null, bundleVerified: false },
      memory: { phase: null, bundleVerified: false },
    }))).toEqual({
      state: 'not-prepared',
      ok: true,
      readyForActivation: false,
      activationRequiresApproval: true,
      rollbackMode: 'rollback-or-resume',
      issues: ['MEMORY_MANIFEST_MISSING', 'REGISTRY_MANIFEST_MISSING'],
    })
  })

  it('requires both VERIFIED bundles, runtime evidence, lock and rollback rehearsal', () => {
    expect(evaluateWorkspaceV2Readiness(evidence())).toEqual({
      state: 'ready-for-approval',
      ok: true,
      readyForActivation: true,
      activationRequiresApproval: true,
      rollbackMode: 'rollback-or-resume',
      issues: [],
    })
  })

  it('keeps incomplete preparation in maintenance and lists deterministic issues', () => {
    const report = evaluateWorkspaceV2Readiness(evidence({
      registry: { phase: 'COPIED', bundleVerified: false },
      memory: { phase: 'PREPARED', bundleVerified: false },
      runtime: { ...evidence().runtime, layeredContext: false },
      rollback: { exclusiveLockAvailable: false, backupVerified: false, dryRunVerified: false },
    }))

    expect(report).toMatchObject({
      state: 'maintenance-incomplete',
      ok: false,
      readyForActivation: false,
      rollbackMode: 'rollback-or-resume',
    })
    expect(report.issues).toEqual([...report.issues].sort())
    expect(report.issues).toEqual(expect.arrayContaining([
      'REGISTRY_PHASE_INCOMPLETE',
      'MEMORY_PHASE_INCOMPLETE',
      'RUNTIME_LAYERED_CONTEXT_UNVERIFIED',
      'ROLLBACK_DRY_RUN_UNVERIFIED',
    ]))
  })

  it('accepts COMMITTED only while all pre-enable evidence remains valid', () => {
    expect(evaluateWorkspaceV2Readiness(evidence({
      registry: { phase: 'COMMITTED', bundleVerified: true },
    }))).toMatchObject({
      state: 'committed-awaiting-enable',
      ok: true,
      readyForActivation: true,
      rollbackMode: 'rollback-or-resume',
    })
    expect(evaluateWorkspaceV2Readiness(evidence({
      registry: { phase: 'COMMITTED', bundleVerified: true },
      rollback: { exclusiveLockAvailable: true, backupVerified: true, dryRunVerified: false },
    }))).toMatchObject({ state: 'not-ready', ok: false, readyForActivation: false })
  })

  it('forbids automatic rollback after V2_WRITES_ENABLED and requires forward repair', () => {
    expect(evaluateWorkspaceV2Readiness(evidence({
      registry: { phase: 'V2_WRITES_ENABLED', bundleVerified: true },
      rollback: { exclusiveLockAvailable: false, backupVerified: false, dryRunVerified: false },
    }))).toEqual({
      state: 'active-forward-repair',
      ok: true,
      readyForActivation: false,
      activationRequiresApproval: true,
      rollbackMode: 'forward-repair',
      issues: [],
    })
  })

  it('fails active v2 health when a runtime surface is not verified', () => {
    expect(evaluateWorkspaceV2Readiness(evidence({
      registry: { phase: 'V2_WRITES_ENABLED', bundleVerified: true },
      runtime: { ...evidence().runtime, transcript: false },
    }))).toMatchObject({
      state: 'active-forward-repair',
      ok: false,
      readyForActivation: false,
      rollbackMode: 'forward-repair',
      issues: ['RUNTIME_TRANSCRIPT_UNVERIFIED'],
    })
  })
})

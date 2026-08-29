import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('production doctor composition', () => {
  it('wires current memory, transcription, scheduler, MCP and optional Docker semantics', () => {
    const cli = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
    const nodeOps = readFileSync(
      new URL('../../core-ts/src/runtime/onboarding-node.ts', import.meta.url),
      'utf8',
    )

    expect(cli).toContain('memory: makeProtectedMemoryDoctorPort({')
    expect(cli).toContain('transcription: makeTranscriptionDoctorProbe({')
    expect(cli).toContain('ownedDockerRecovery: makeNodeOwnedDockerProductionRecoveryDoctorProbe({')
    expect(cli).toContain('autoSkills: {')
    expect(cli).toContain('inspectNodeAutoSkillStoreV2({')
    expect(cli).toContain('forgetAutoSkillsBySource?.(selector)')
    expect(cli).toContain('claimAutoSkillsBySource?.(selector)')
    expect(cli).toContain("if (!existsSync(autoSkillStateRoot)) return")
    expect(cli).toContain('afterReplyDelivered: ({ sessionId, turnId, result }) => {')
    expect(cli).toContain('conversationalSessionControl.confirmReplyDelivered({ sessionId, turnId })')
    expect(cli).toContain('observeAuthenticatedOperatorTurn: ({ text, sessionId, turnId }) => {')
    expect(cli).toContain('recoverNodeSessionAutoNameStore({')
    expect(cli).toContain("path: join(base, 'session-auto-names-v1.json')")
    expect(cli).toContain('evidenceId: result.verifiedWorkflowDelivery.evidenceId')
    expect(cli).toContain("throw new Error('AUTO_SKILL_JUDGE_IDENTITY_CONFLICT')")
    expect(cli).toContain('root: doctorRoots.protectedMemory')
    expect(nodeOps).toContain('required: (): boolean => nodeDockerRequired(env)')
    expect(nodeOps).toContain("scheduleKind: (): 'in-process' => 'in-process'")
    expect(nodeOps).toContain('mcpInspection = inspectNodeMcpAllowlist(mcpAllowlistPath)')
    expect(nodeOps).not.toContain("execFileSync('crontab'")
  })
})

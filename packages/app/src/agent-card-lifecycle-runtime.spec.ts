import { describe, expect, it } from 'vitest'
import {
  makeAgentCardRegistry,
  type AgentCardBinding,
  type ApprovalDecision,
  type PendingAction,
} from '@aisy/core'

import {
  AgentCardLifecycleRuntimeError,
  makeAgentCardLifecycleRuntime,
} from './agent-card-lifecycle-runtime.js'

const draft = (instructions: string, name = 'researcher') => `---
name: ${name}
description: ${name}
skills: []
mcp_allowlist: []
tool_tiers: { read_file: 1 }
max_iterations: 8
context_strategy: compact
provenance: user
---
${instructions}`

function confirmer(seen: PendingAction[]): (action: PendingAction) => Promise<ApprovalDecision> {
  return async (action) => {
    seen.push(action)
    return {
      decision: 'confirmed',
      proof: {
        cardId: `card-${seen.length}`,
        actionId: action.actionId,
        actionHash: action.actionHash,
        confirmedAt: '2026-08-12T10:00:00Z',
        stepUpVerified: true,
      },
    }
  }
}

describe('target-oriented AgentCard lifecycle runtime', () => {
  it('creates two names and returns separate Workspace/current Project catalogs', async () => {
    const registry = makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' })
    const runtime = makeAgentCardLifecycleRuntime({
      registry,
      configuredName: 'main',
      cutoverActive: false,
      currentBinding: () => ({ scope: 'project', projectId: 'project-a' }),
      approvedBy: 'operator-a',
    })
    await runtime.createDraft({
      markdown: draft('Alpha DNA.', 'alpha'),
      binding: { scope: 'workspace' },
      approve: confirmer([]),
    })
    await runtime.createDraft({
      markdown: draft('Reviewer DNA.', 'reviewer'),
      binding: { scope: 'project', projectId: 'project-a' },
      approve: confirmer([]),
    })
    expect(runtime.catalog().workspace.map(entry => entry.name)).toEqual(['alpha'])
    expect(runtime.catalog().project.map(entry => entry.name)).toEqual(['reviewer'])
  })

  it('refuses Project drift before legacy read or approval', async () => {
    let binding: AgentCardBinding = { scope: 'project', projectId: 'project-a' }
    let reads = 0
    const approvals: PendingAction[] = []
    const runtime = makeAgentCardLifecycleRuntime({
      registry: makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' }),
      configuredName: '',
      cutoverActive: false,
      currentBinding: () => binding,
      approvedBy: 'operator-a',
      legacy: { readExact: async () => { reads += 1; return draft('Legacy DNA.') } },
    })
    const target = { binding, name: 'researcher' } as const
    binding = { scope: 'project', projectId: 'project-b' }
    await expect(runtime.importLegacy({ target, approve: confirmer(approvals) }))
      .rejects.toMatchObject({ code: 'AGENT_CARD_BINDING_STALE' })
    expect(reads).toBe(0)
    expect(approvals).toEqual([])
  })

  it('distinguishes create from publish and rejects rename before approval', async () => {
    const approvals: PendingAction[] = []
    const runtime = makeAgentCardLifecycleRuntime({
      registry: makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' }),
      configuredName: '',
      cutoverActive: false,
      currentBinding: () => ({ scope: 'workspace' }),
      approvedBy: 'operator-a',
    })
    const target = { binding: { scope: 'workspace' as const }, name: 'researcher' }
    await expect(runtime.publishDraft({ target, markdown: draft('One.'), approve: confirmer(approvals) }))
      .rejects.toMatchObject({ code: 'AGENT_CARD_HISTORY_EMPTY' })
    await runtime.createDraft({ markdown: draft('One.'), binding: target.binding, approve: confirmer(approvals) })
    await expect(runtime.createDraft({ markdown: draft('Again.'), binding: target.binding, approve: confirmer(approvals) }))
      .rejects.toMatchObject({ code: 'AGENT_CARD_HISTORY_EXISTS' })
    const beforeRename = approvals.length
    await expect(runtime.publishDraft({
      target,
      markdown: draft('Renamed.', 'reviewer'),
      approve: confirmer(approvals),
    })).rejects.toMatchObject({ code: 'AGENT_CARD_NAME_MISMATCH' })
    expect(approvals).toHaveLength(beforeRename)
  })

  it('rechecks Project binding after legacy read and before approval', async () => {
    let binding: AgentCardBinding = { scope: 'project', projectId: 'project-a' }
    const approvals: PendingAction[] = []
    const runtime = makeAgentCardLifecycleRuntime({
      registry: makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' }),
      configuredName: '',
      cutoverActive: false,
      currentBinding: () => binding,
      approvedBy: 'operator-a',
      legacy: { readExact: async () => {
        binding = { scope: 'project', projectId: 'project-b' }
        return draft('Legacy DNA.')
      } },
    })
    const target = { binding, name: 'researcher' } as const
    await expect(runtime.importLegacy({ target, approve: confirmer(approvals) }))
      .rejects.toMatchObject({ code: 'AGENT_CARD_BINDING_STALE' })
    expect(approvals).toEqual([])
  })

  it('rolls an archived first revision forward to revision two', async () => {
    const runtime = makeAgentCardLifecycleRuntime({
      registry: makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' }),
      configuredName: '',
      cutoverActive: false,
      currentBinding: () => ({ scope: 'workspace' }),
      approvedBy: 'operator-a',
    })
    const approve = confirmer([])
    const target = { binding: { scope: 'workspace' as const }, name: 'researcher' }
    await runtime.createDraft({ markdown: draft('One.'), binding: target.binding, approve })
    await expect(runtime.rollback({ target, approve }))
      .rejects.toMatchObject({ code: 'AGENT_CARD_HISTORY_EMPTY' })
    await runtime.archive({ target, approve })
    const restored = await runtime.rollback({ target, approve })
    expect(restored.revision).toBe(2)
    expect(runtime.detail(target).active?.revision).toBe(2)
  })

  it('emits distinct redacted non-load-bearing audit for all five verbs', async () => {
    const marker = 'PRIVATE-MARKER-DO-NOT-EMIT'
    const events: Array<{ event: string; payload: Readonly<Record<string, unknown>> }> = []
    const registry = makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' })
    const runtime = makeAgentCardLifecycleRuntime({
      registry,
      configuredName: '',
      cutoverActive: false,
      currentBinding: () => ({ scope: 'workspace' }),
      approvedBy: 'operator-a',
      legacy: { readExact: async () => draft(marker, 'legacy') },
      emit: (event, payload) => events.push({ event, payload }),
      nowIso: () => '2026-08-12T11:00:00Z',
    })
    const approve = confirmer([])
    const target = { binding: { scope: 'workspace' as const }, name: 'researcher' }
    await runtime.createDraft({ markdown: draft(marker), binding: target.binding, approve })
    await runtime.publishDraft({ target, markdown: draft(`${marker}-two`), approve })
    await runtime.rollback({ target, approve })
    await runtime.archive({ target, approve })
    await runtime.importLegacy({
      target: { binding: target.binding, name: 'legacy' },
      approve,
    })
    expect(events.map(item => item.event)).toEqual([
      'agent_card.created',
      'agent_card.published',
      'agent_card.rolled_back',
      'agent_card.archived',
      'agent_card.legacy_imported',
    ])
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(marker)
    for (const revision of [
      ...registry.history(target.binding, 'researcher'),
      ...registry.history(target.binding, 'legacy'),
    ]) expect(serialized).not.toContain(revision.hash)

    const throwing = makeAgentCardLifecycleRuntime({
      registry: makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' }),
      configuredName: '', cutoverActive: false,
      currentBinding: () => ({ scope: 'workspace' }), approvedBy: 'operator-a',
      emit: () => { throw new Error('audit offline') },
    })
    await expect(throwing.createDraft({
      markdown: draft('Committed.'), binding: { scope: 'workspace' }, approve,
    })).resolves.toMatchObject({ revision: 1 })
  })

  it('requires an exact confirmed step-up proof', async () => {
    const runtime = makeAgentCardLifecycleRuntime({
      registry: makeAgentCardRegistry(), configuredName: '', cutoverActive: false,
      currentBinding: () => ({ scope: 'workspace' }), approvedBy: 'operator-a',
    })
    await expect(runtime.createDraft({
      markdown: draft('DNA.'), binding: { scope: 'workspace' },
      approve: async () => ({ decision: 'rejected', reason: 'operator' }),
    })).rejects.toBeInstanceOf(AgentCardLifecycleRuntimeError)
    await expect(runtime.createDraft({
      markdown: draft('DNA.'), binding: { scope: 'workspace' },
      approve: async () => ({ decision: 'confirmed' }),
    })).rejects.toMatchObject({ code: 'AGENT_CARD_APPROVAL_PROOF_INVALID' })
  })
})

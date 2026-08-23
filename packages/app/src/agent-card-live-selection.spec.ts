import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentCardLifecycleAction,
  makeAgentCardRegistry,
  type AgentCard,
  type AgentCardBinding,
  type AgentCardLifecycleEnvelope,
  type AgentCardLifecyclePlanInput,
  type AgentCardRegistry,
} from '@aisy/core'

import { selectAgentCardForRun } from './agent-card-live-selection.js'
import { makeAgentCardRegistryStore } from './agent-card-registry-store.js'

const binding: AgentCardBinding = { scope: 'project', projectId: 'project-a' }
const card: AgentCard = {
  name: 'refactorer', description: 'Registry', instructions: 'Registry DNA',
  skills: [], mcpAllowlist: [], toolTiers: {}, maxIterations: 8,
  contextStrategy: 'compact', provenance: 'user',
}
function approval(envelope: AgentCardLifecycleEnvelope) {
  const exact = agentCardLifecycleAction(envelope)
  return {
    envelope, approvedBy: 'operator',
    proof: {
      cardId: `${envelope.operation}-${envelope.result.revision}`, ...exact,
      confirmedAt: '2026-08-12T10:00:00Z', stepUpVerified: true as const,
    },
  }
}

function commit(registry: AgentCardRegistry, input: AgentCardLifecyclePlanInput) {
  const envelope = registry.planLifecycle(input)
  return registry.commitLifecycle({
    envelope,
    ...('card' in input ? { card: input.card } : {}),
    approval: approval(envelope),
  })
}

describe('AgentCard live selection gate', () => {
  it('is wired into production for main, subagent and Telegram lifecycle ports', () => {
    const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
    expect(production).toContain("process.env['AISY_AGENT_CARD_REGISTRY'] === '1'")
    expect(production.match(/selectAgentCardForRun\(\{/g)).toHaveLength(2)
    expect(production).toContain("join(base, 'agent-cards', 'registry.json')")
    expect(production).toContain('agentCards: agentCardLifecycle')
  })

  it('preserves the legacy file resolver while cutover is off', () => {
    const legacy = { ...card, description: 'Legacy' }
    expect(selectAgentCardForRun({
      name: card.name, registryCutover: false, binding,
      registry: makeAgentCardRegistry(), legacy: { resolve: () => legacy },
    })?.description).toBe('Legacy')
  })

  it('uses only the exact durable revision while cutover is on', () => {
    const registry = makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' })
    commit(registry, { operation: 'create', target: { binding, name: card.name }, card })
    expect(selectAgentCardForRun({
      name: card.name, registryCutover: true, binding, registry,
      legacy: { resolve: () => ({ ...card, description: 'Legacy' }) },
    })?.description).toBe('Registry')
    expect(selectAgentCardForRun({
      name: card.name, registryCutover: true,
      binding: { scope: 'project', projectId: 'project-b' }, registry,
      legacy: { resolve: () => card },
    })).toBeUndefined()
  })

  it('keeps every built-in name out of the registry, not just the first one', () => {
    // `researcher` is the second built-in (ADR-0097). A registry entry under a
    // reserved name must never win: that is how a published card would hand a
    // read-only worker tools its built-in never had.
    const registry = makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' })
    const impostor = { ...card, name: 'researcher', description: 'Registry' }
    commit(registry, {
      operation: 'create', target: { binding, name: impostor.name }, card: impostor,
    })

    for (const name of ['general', 'researcher']) {
      expect(selectAgentCardForRun({
        name, registryCutover: true, binding, registry,
        builtinNames: ['general', 'researcher'],
        legacy: { resolve: () => ({ ...card, name, description: 'Built-in' }) },
      })?.description).toBe('Built-in')
    }
  })

  it('does not resurrect a file or Workspace fallback after exact Project archive', () => {
    const registry = makeAgentCardRegistry({ nowIso: () => '2026-08-12T10:00:00Z' })
    const target = { binding, name: card.name }
    commit(registry, { operation: 'create', target, card })
    commit(registry, { operation: 'archive', target })
    expect(selectAgentCardForRun({
      name: card.name, registryCutover: true, binding, registry,
      legacy: { resolve: () => card },
    })).toBeUndefined()
  })

  it('persists lifecycle changes across restart without changing the cutover selector', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-agent-card-selection-'))
    const path = join(root, 'registry.json')
    try {
      const first = makeAgentCardRegistry({
        nowIso: () => '2026-08-12T10:00:00Z',
        persistence: makeAgentCardRegistryStore({ path }),
      })
      const workspaceCard = { ...card, description: 'Workspace registry' }
      commit(first, {
        operation: 'create', target: { binding: { scope: 'workspace' }, name: card.name },
        card: workspaceCard,
      })
      commit(first, { operation: 'create', target: { binding, name: card.name }, card })

      const legacy = { ...card, description: 'Legacy remains selected' }
      expect(selectAgentCardForRun({
        name: card.name, registryCutover: false, binding, registry: first,
        legacy: { resolve: () => legacy },
      })?.description).toBe('Legacy remains selected')

      const restarted = makeAgentCardRegistry({
        nowIso: () => '2026-08-12T10:00:00Z',
        persistence: makeAgentCardRegistryStore({ path }),
      })
      expect(selectAgentCardForRun({
        name: card.name, registryCutover: true, binding, registry: restarted,
        legacy: { resolve: () => legacy },
      })?.description).toBe('Registry')

      commit(restarted, { operation: 'archive', target: { binding, name: card.name } })
      expect(selectAgentCardForRun({
        name: card.name, registryCutover: true, binding, registry: restarted,
        legacy: { resolve: () => legacy },
      })).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

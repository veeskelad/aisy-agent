import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentCardLifecycleAction,
  canonicalAgentCardHash,
  makeAgentCardRegistry,
  type AgentCard,
  type AgentCardBinding,
  type AgentCardLifecycleEnvelope,
  type AgentCardLifecyclePlanInput,
  type AgentCardRegistry,
} from '@aisy/core'

import { makeAgentCardRegistryStore } from './agent-card-registry-store.js'

const roots: string[] = []
const workspace = Object.freeze({ scope: 'workspace' as const })
const project = (projectId: string): AgentCardBinding => Object.freeze({ scope: 'project', projectId })

function statePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'aisy-card-registry-'))
  roots.push(root)
  return join(root, 'agent-cards.json')
}

const card = (overrides: Partial<AgentCard> = {}): AgentCard => ({
  name: 'researcher',
  description: 'Read-only research worker',
  instructions: 'Investigate and report.',
  skills: [],
  mcpAllowlist: [],
  toolTiers: { read_file: 1 },
  maxIterations: 8,
  contextStrategy: 'compact',
  provenance: 'user',
  ...overrides,
}) as AgentCard

const approval = (envelope: AgentCardLifecycleEnvelope) => ({
  envelope,
  approvedBy: 'operator',
  proof: {
    cardId: `card-${envelope.operation}-${envelope.result.revision}`,
    ...agentCardLifecycleAction(envelope),
    confirmedAt: '2026-07-29T10:00:00Z',
    stepUpVerified: true as const,
  },
})

function commit(store: AgentCardRegistry, input: AgentCardLifecyclePlanInput) {
  const envelope = store.planLifecycle(input)
  return store.commitLifecycle({
    envelope,
    ...('card' in input ? { card: input.card } : {}),
    approval: approval(envelope),
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('agent card registry persistence (ADR-0069)', () => {
  it('restores published revisions after a restart', () => {
    const path = statePath()
    const value = card()
    const first = makeAgentCardRegistry({
      persistence: makeAgentCardRegistryStore({ path }),
      nowIso: () => '2026-07-29T10:00:00Z',
    })
    commit(first, { operation: 'create', target: { binding: workspace, name: value.name }, card: value })

    const restarted = makeAgentCardRegistry({ persistence: makeAgentCardRegistryStore({ path }) })
    expect(restarted.resolveActive('researcher', workspace)?.revision).toBe(1)
    // The restored registry continues the revision sequence rather than restarting it.
    expect(restarted.planLifecycle({
      operation: 'publish', target: { binding: workspace, name: value.name }, card: value,
    }).result.revision).toBe(2)
  })

  it('persists an archive so the card does not come back alive after a restart', () => {
    const path = statePath()
    const value = card()
    const store = makeAgentCardRegistry({
      persistence: makeAgentCardRegistryStore({ path }),
      nowIso: () => '2026-07-29T10:00:00Z',
    })
    const target = { binding: workspace, name: value.name }
    commit(store, { operation: 'create', target, card: value })
    commit(store, { operation: 'archive', target })

    const restarted = makeAgentCardRegistry({ persistence: makeAgentCardRegistryStore({ path }) })
    expect(restarted.resolveActive('researcher', workspace)).toBeNull()
    expect(restarted.resolveExact(workspace, 'researcher', 1)?.status).toBe('archived')
  })

  it('does not resurrect a superseded revision after archive and restart', () => {
    const path = statePath()
    const firstCard = card({ instructions: 'Revision one.' })
    const secondCard = card({ instructions: 'Revision two.' })
    const store = makeAgentCardRegistry({
      persistence: makeAgentCardRegistryStore({ path }),
      nowIso: () => '2026-07-29T10:00:00Z',
    })
    const target = { binding: workspace, name: firstCard.name }
    commit(store, { operation: 'create', target, card: firstCard })
    commit(store, { operation: 'publish', target, card: secondCard })
    commit(store, { operation: 'archive', target })

    const restarted = makeAgentCardRegistry({ persistence: makeAgentCardRegistryStore({ path }) })
    expect(restarted.resolveActive('researcher', workspace)).toBeNull()
    expect(restarted.history(workspace, 'researcher').map(item => item.status))
      .toEqual(['superseded', 'archived'])
  })

  it('drops a hand-edited revision whose content no longer matches its hash', () => {
    const path = statePath()
    const value = card()
    const store = makeAgentCardRegistry({
      persistence: makeAgentCardRegistryStore({ path }),
      nowIso: () => '2026-07-29T10:00:00Z',
    })
    commit(store, { operation: 'create', target: { binding: workspace, name: value.name }, card: value })

    // Widen the capabilities on disk, keeping the approved hash.
    const state = JSON.parse(readFileSync(path, 'utf8')) as {
      revisions: Array<{ card: { toolTiers: Record<string, number> } }>
    }
    state.revisions[0]!.card.toolTiers = { bash: 3 }
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 })

    const restarted = makeAgentCardRegistry({ persistence: makeAgentCardRegistryStore({ path }) })
    expect(restarted.resolveActive('researcher', workspace)).toBeNull()
    expect(restarted.history(workspace, 'researcher')).toEqual([])
  })

  it('treats corrupt, oversized and absent state as no revisions at all', () => {
    const corrupt = statePath()
    writeFileSync(corrupt, '{ not json', { mode: 0o600 })
    expect(makeAgentCardRegistry({ persistence: makeAgentCardRegistryStore({ path: corrupt }) })
      .history(workspace, 'researcher')).toEqual([])

    const absent = statePath()
    expect(makeAgentCardRegistry({ persistence: makeAgentCardRegistryStore({ path: absent }) })
      .history(workspace, 'researcher')).toEqual([])

    const huge = statePath()
    writeFileSync(huge, 'x'.repeat(4 * 1024 * 1024 + 1), { mode: 0o600 })
    expect(makeAgentCardRegistry({ persistence: makeAgentCardRegistryStore({ path: huge }) })
      .history(workspace, 'researcher')).toEqual([])
  })

  it('writes the state file privately', () => {
    const path = statePath()
    const value = card()
    const store = makeAgentCardRegistry({
      persistence: makeAgentCardRegistryStore({ path }),
      nowIso: () => '2026-07-29T10:00:00Z',
    })
    commit(store, { operation: 'create', target: { binding: workspace, name: value.name }, card: value })

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('restores exact Project bindings without cross-project authority', () => {
    const path = statePath()
    const alpha = card({ instructions: 'Alpha only.' })
    const first = makeAgentCardRegistry({
      persistence: makeAgentCardRegistryStore({ path }),
      nowIso: () => '2026-07-29T10:00:00Z',
    })
    commit(first, {
      operation: 'create',
      target: { binding: project('project-a'), name: alpha.name },
      card: alpha,
    })

    const restarted = makeAgentCardRegistry({ persistence: makeAgentCardRegistryStore({ path }) })
    expect(restarted.resolveActive('researcher', project('project-a'))?.card.instructions)
      .toBe('Alpha only.')
    expect(restarted.resolveActive('researcher', project('project-b'))).toBeNull()
  })

  it('migrates only attributable v1 Workspace revisions and writes schema v2 next', () => {
    const path = statePath()
    const workspaceCard = card({ instructions: 'Workspace legacy.' })
    const unsafeProjectCard = card({ instructions: 'Unattributed Project legacy.' })
    const revision = (scope: 'workspace' | 'project', value: AgentCard) => ({
      scope,
      name: value.name,
      revision: 1,
      hash: canonicalAgentCardHash(value),
      status: 'active',
      provenance: 'published',
      publishedAt: '2026-07-29T10:00:00Z',
      card: value,
    })
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      revisions: [revision('workspace', workspaceCard), revision('project', unsafeProjectCard)],
    }), { mode: 0o600 })

    const migrated = makeAgentCardRegistry({
      persistence: makeAgentCardRegistryStore({ path }),
      nowIso: () => '2026-07-29T11:00:00Z',
    })
    expect(migrated.resolveActive('researcher', workspace)?.card.instructions).toBe('Workspace legacy.')
    expect(migrated.resolveActive('researcher', project('project-a'))?.binding).toEqual(workspace)

    const projectCard = card({ instructions: 'Attributed Project.' })
    commit(migrated, {
      operation: 'create',
      target: { binding: project('project-a'), name: projectCard.name },
      card: projectCard,
    })
    const saved = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion: number
      revisions: Array<{ binding?: AgentCardBinding; scope?: string }>
    }
    expect(saved.schemaVersion).toBe(2)
    expect(saved.revisions).toHaveLength(2)
    expect(saved.revisions.map((item) => item.binding)).toEqual([
      workspace,
      project('project-a'),
    ])
    expect(saved.revisions.every((item) => item.scope === undefined)).toBe(true)
  })
})

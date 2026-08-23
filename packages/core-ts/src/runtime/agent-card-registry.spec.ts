import { describe, expect, it } from 'vitest'

import {
  agentCardLifecycleAction,
  canonicalAgentCardHash,
  makeAgentCardRegistry,
  type AgentCardBinding,
  type AgentCardLifecycleEnvelope,
  type AgentCardLifecyclePlanInput,
  type AgentCardRegistry,
  type AgentCardRegistryStateV2,
  type AgentCardRegistryPersistencePort,
} from './agent-card-registry.js'
import type { AgentCard } from '../orchestration/index.js'

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

const registry = (nowIso = () => '2026-07-29T10:00:00Z') => makeAgentCardRegistry({ nowIso })
const workspace = Object.freeze({ scope: 'workspace' as const })
const project = (projectId: string): AgentCardBinding => Object.freeze({ scope: 'project', projectId })

describe('agent card registry (ADR-0069)', () => {
  function envelopeApproval(planned: AgentCardLifecycleEnvelope) {
    const exact = agentCardLifecycleAction(planned)
    return {
      envelope: planned,
      approvedBy: 'operator',
      proof: {
        cardId: `card-${exact.actionHash.slice(0, 16)}`,
        ...exact,
        confirmedAt: '2026-08-12T10:00:00Z',
        stepUpVerified: true as const,
      },
    }
  }

  function commitPlanned(
    store: AgentCardRegistry,
    planned: AgentCardLifecycleEnvelope,
    value?: AgentCard,
  ) {
    return store.commitLifecycle({
      envelope: planned,
      ...(value === undefined ? {} : { card: value }),
      approval: envelopeApproval(planned),
    })
  }

  function commitInput(store: AgentCardRegistry, input: AgentCardLifecyclePlanInput) {
    const planned = store.planLifecycle(input)
    return commitPlanned(store, planned, 'card' in input ? input.card : undefined)
  }

  function publish(store: AgentCardRegistry, binding: AgentCardBinding, value: AgentCard) {
    const operation = store.history(binding, value.name).length === 0 ? 'create' : 'publish'
    return commitInput(store, { operation, target: { binding, name: value.name }, card: value })
  }

  function archive(store: AgentCardRegistry, binding: AgentCardBinding, name: string) {
    return commitInput(store, { operation: 'archive', target: { binding, name } })
  }

  it('enumerates exact bindings without card content', () => {
    const store = registry()
    commitInput(store, { operation: 'create', target: { binding: workspace, name: 'zeta' }, card: card({ name: 'zeta' }) })
    commitInput(store, { operation: 'create', target: { binding: workspace, name: 'alpha' }, card: card({ name: 'alpha' }) })
    commitInput(store, { operation: 'create', target: { binding: project('p1'), name: 'alpha' }, card: card({ name: 'alpha' }) })

    const view = store.catalog(workspace)
    expect(view.map(entry => entry.name)).toEqual(['alpha', 'zeta'])
    expect(JSON.stringify(view)).not.toContain('instructions')
    expect(store.catalog(project('p2'))).toEqual([])
  })

  it('builds deterministic create and archive envelopes', () => {
    const store = registry()
    const target = { binding: workspace, name: 'researcher' } as const
    const create = store.planLifecycle({ operation: 'create', target, card: card() })
    expect(create).toMatchObject({
      operation: 'create', expectedHead: null, sourceRevision: null,
      result: { revision: 1, status: 'active' },
    })
    commitPlanned(store, create, card())
    expect(store.planLifecycle({ operation: 'archive', target })).toMatchObject({
      expectedHead: { revision: 1, status: 'active' },
      sourceRevision: null,
      result: { revision: 1, status: 'archived' },
    })
  })

  it('publishes forward-only revisions with a byte-stable hash', () => {
    const store = registry()
    const first = publish(store, workspace, card())
    expect(first.revision).toBe(1)
    expect(first.hash).toBe(canonicalAgentCardHash(card()))
    expect(first.provenance).toBe('published')

    const edited = card({ instructions: 'Investigate, verify and report.' })
    const second = publish(store, workspace, edited)
    expect(second.revision).toBe(2)
    expect(second.hash).not.toBe(first.hash)
    expect(store.history(workspace, 'researcher').map(item => item.revision)).toEqual([1, 2])
    expect(store.history(workspace, 'researcher').map(item => item.status))
      .toEqual(['superseded', 'active'])
  })

  it('hashes identical cards identically regardless of key order', () => {
    const a = card({ name: 'x', skills: ['s'] })
    const b = {
      provenance: 'user', contextStrategy: 'compact', maxIterations: 8,
      toolTiers: { read_file: 1 }, mcpAllowlist: [], skills: ['s'],
      instructions: 'Investigate and report.', description: 'Read-only research worker', name: 'x',
    } as AgentCard
    expect(canonicalAgentCardHash(a)).toBe(canonicalAgentCardHash(b))
  })

  it('archives forward-only and refuses to run an archived revision', () => {
    const store = registry()
    const value = card()
    const published = publish(store, workspace, value)

    const archived = archive(store, workspace, 'researcher')
    expect(archived.status).toBe('archived')
    expect(archived.hash).toBe(published.hash)
    expect(store.resolveActive('researcher', workspace)).toBeNull()
    // Still auditable: a finished run can prove what it executed.
    expect(store.resolveExact(workspace, 'researcher', 1)?.status).toBe('archived')

    expect(() => archive(store, workspace, 'researcher'))
      .toThrowError(expect.objectContaining({ reason: 'not-active' }))
  })

  it('does not reactivate a superseded revision when the latest is archived', () => {
    const store = registry()
    const first = card({ instructions: 'Revision one.' })
    const second = card({ instructions: 'Revision two.' })
    publish(store, workspace, first)
    publish(store, workspace, second)
    archive(store, workspace, second.name)

    expect(store.resolveActive(second.name, workspace)).toBeNull()
    expect(store.history(workspace, second.name).map(item => item.status))
      .toEqual(['superseded', 'archived'])
  })

  it('shadows the workspace card with a project card instead of merging them', () => {
    const store = registry()
    const workspaceCard = card({ toolTiers: { read_file: 1 } })
    const projectCard = card({ toolTiers: { list_dir: 1 } })
    publish(store, workspace, workspaceCard)
    publish(store, project('project-a'), projectCard)

    const resolved = store.resolveActive('researcher', project('project-a'))
    expect(resolved?.binding).toEqual(project('project-a'))
    expect(resolved?.card.toolTiers).toEqual({ list_dir: 1 })

    // Workspace scope never sees the project card.
    expect(store.resolveActive('researcher', workspace)?.binding).toEqual(workspace)
  })

  it('isolates same-name Project revisions and approvals by exact projectId', () => {
    const store = registry()
    const alpha = card({ instructions: 'Alpha only.' })
    const beta = card({ instructions: 'Beta only.' })
    publish(store, project('project-a'), alpha)
    publish(store, project('project-b'), beta)

    expect(store.resolveActive('researcher', project('project-a'))?.card.instructions).toBe('Alpha only.')
    expect(store.resolveActive('researcher', project('project-b'))?.card.instructions).toBe('Beta only.')
    expect(store.history(project('project-a'), 'researcher')).toHaveLength(1)
    expect(store.history(project('project-b'), 'researcher')).toHaveLength(1)

    const next = card({ instructions: 'Alpha revision two.' })
    expect(publish(store, project('project-a'), next).revision).toBe(2)
    expect(store.history(project('project-b'), 'researcher')).toHaveLength(1)
  })

  it('falls back to the workspace card only when the project has none', () => {
    const store = registry()
    const value = card()
    publish(store, workspace, value)
    expect(store.resolveActive('researcher', project('project-a'))?.binding).toEqual(workspace)
  })

  it('does not fall back to Workspace after an exact Project card is archived', () => {
    const store = registry()
    const workspaceCard = card({ instructions: 'Workspace.' })
    const projectCard = card({ instructions: 'Project.' })
    publish(store, workspace, workspaceCard)
    publish(store, project('project-a'), projectCard)
    archive(store, project('project-a'), projectCard.name)
    expect(store.resolveActive('researcher', project('project-a'))).toBeNull()
    expect(store.resolveActive('researcher', project('project-b'))?.binding).toEqual(workspace)
  })

  it('accepts a legacy import only as revision 1 and marks its provenance', () => {
    const store = registry()
    const value = card()
    const imported = commitInput(store, {
      operation: 'import-legacy', target: { binding: workspace, name: value.name }, card: value,
    })
    expect(imported.provenance).toBe('legacy-import')
    expect(imported.revision).toBe(1)

    const edited = card({ description: 'edited' })
    expect(() => store.planLifecycle({
      operation: 'import-legacy', target: { binding: workspace, name: edited.name }, card: edited,
    })).toThrowError(expect.objectContaining({ reason: 'history-exists' }))
  })

  it('refuses a malformed card before any revision is created', () => {
    const store = registry()
    const broken = card({ instructions: '' })
    expect(() => store.planLifecycle({
      operation: 'create', target: { binding: workspace, name: broken.name }, card: broken,
    }))
      .toThrowError(expect.objectContaining({ reason: 'invalid-card' }))
    expect(store.history(workspace, 'researcher')).toEqual([])
  })

  it.each([
    card({ provenance: 'operator' as never }),
    card({ skills: ['same', 'same'] }),
    card({ mcpAllowlist: ['../escape'] }),
    card({ toolTiers: { bash: 4 } }),
    card({ maxIterations: 0 }),
    { ...card(), surpriseAuthority: true } as AgentCard,
    card({ name: 'general' }),
    card({ provenance: 'builtin' }),
  ])('refuses a structurally invalid or reserved lifecycle card', (broken) => {
    const store = registry()
    expect(() => store.planLifecycle({
      operation: 'create', target: { binding: workspace, name: broken.name }, card: broken,
    }))
      .toThrowError(expect.objectContaining({ reason: 'invalid-card' }))
    expect(store.history(workspace, broken.name)).toEqual([])
  })

  it('refuses a scope outside Workspace and Project', () => {
    const store = registry()
    const value = card()
    expect(() => store.planLifecycle({
      operation: 'create',
      target: { binding: { scope: 'session' } as unknown as AgentCardBinding, name: value.name },
      card: value,
    }))
      .toThrowError(expect.objectContaining({ reason: 'invalid-scope' }))
  })

  it.each([
    { scope: 'project' },
    { scope: 'project', projectId: '../escape' },
    { scope: 'workspace', projectId: 'project-a' },
    { scope: 'project', projectId: 'project-a', inherited: true },
  ])('refuses an incomplete, unsafe or extended binding', (binding) => {
    const store = registry()
    expect(() => store.planLifecycle({
      operation: 'create',
      target: { binding: binding as unknown as AgentCardBinding, name: card().name },
      card: card(),
    }))
      .toThrowError(expect.objectContaining({ reason: 'invalid-scope' }))
  })

  it('reports the exact revision and hash an approval must name', () => {
    const store = registry()
    const value = card()
    expect(store.planLifecycle({
      operation: 'create', target: { binding: workspace, name: value.name }, card: value,
    }).result).toEqual({ revision: 1, status: 'active', hash: canonicalAgentCardHash(value) })
    publish(store, workspace, value)
    expect(store.planLifecycle({
      operation: 'publish', target: { binding: workspace, name: value.name }, card: value,
    }).result.revision).toBe(2)
  })

  it('keeps published revisions immutable against later mutation of the source object', () => {
    const store = registry()
    const value = card({ skills: ['review'], mcpAllowlist: ['tracker'] })
    const published = publish(store, workspace, value)
    ;(value as { maxIterations: number }).maxIterations = 999
    value.skills.push('surprise')
    value.mcpAllowlist.push('surprise')
    value.toolTiers['bash'] = 3

    expect(published.card.maxIterations).toBe(8)
    expect(published.card.skills).toEqual(['review'])
    expect(published.card.mcpAllowlist).toEqual(['tracker'])
    expect(published.card.toolTiers).toEqual({ read_file: 1 })
    expect(Object.isFrozen(published.card.skills)).toBe(true)
    expect(Object.isFrozen(published.card.mcpAllowlist)).toBe(true)
    expect(Object.isFrozen(published.card.toolTiers)).toBe(true)
    expect(store.resolveActive('researcher', workspace)?.card.maxIterations).toBe(8)
  })

  it('does not publish in memory or burn the approval when durable save fails', () => {
    let fail = true
    const persistence: AgentCardRegistryPersistencePort = {
      load: () => undefined,
      save: () => {
        if (fail) throw new Error('disk full')
      },
    }
    const store = makeAgentCardRegistry({ persistence, nowIso: () => '2026-07-29T10:00:00Z' })
    const value = card()
    const planned = store.planLifecycle({
      operation: 'create', target: { binding: workspace, name: value.name }, card: value,
    })
    const once = envelopeApproval(planned)
    const execute = () => store.commitLifecycle({ envelope: planned, card: value, approval: once })

    expect(execute).toThrow('disk full')
    expect(store.resolveActive('researcher', workspace)).toBeNull()
    expect(store.planLifecycle({
      operation: 'create', target: { binding: workspace, name: value.name }, card: value,
    }).result.revision).toBe(1)

    fail = false
    expect(execute().revision).toBe(1)
  })

  it('keeps a revision active when durable archive save fails', () => {
    let failArchive = false
    const persistence: AgentCardRegistryPersistencePort = {
      load: () => undefined,
      save: () => {
        if (failArchive) throw new Error('disk full')
      },
    }
    const store = makeAgentCardRegistry({ persistence, nowIso: () => '2026-07-29T10:00:00Z' })
    const value = card()
    publish(store, workspace, value)
    const planned = store.planLifecycle({
      operation: 'archive', target: { binding: workspace, name: value.name },
    })
    const archiveApproval = envelopeApproval(planned)
    const execute = () => store.commitLifecycle({ envelope: planned, approval: archiveApproval })
    failArchive = true
    expect(execute).toThrow('disk full')
    expect(store.resolveActive(value.name, workspace)?.status).toBe('active')

    failArchive = false
    expect(execute().status).toBe('archived')
  })

  it('plans create publish archive and rollback from the exact head', () => {
    const store = registry()
    const target = { binding: workspace, name: 'researcher' } as const
    const first = card({ instructions: 'Revision one.' })
    const second = card({ instructions: 'Revision two.' })

    commitInput(store, { operation: 'create', target, card: first })
    const publish = store.planLifecycle({ operation: 'publish', target, card: second })
    expect(publish).toMatchObject({
      expectedHead: { revision: 1, status: 'active', hash: canonicalAgentCardHash(first) },
      sourceRevision: null,
      result: { revision: 2, status: 'active', hash: canonicalAgentCardHash(second) },
    })
    commitPlanned(store, publish, second)
    commitInput(store, { operation: 'archive', target })

    const rollback = store.planLifecycle({ operation: 'rollback', target })
    expect(rollback).toMatchObject({
      expectedHead: { revision: 2, status: 'archived' },
      sourceRevision: 2,
      result: { revision: 3, status: 'active', hash: canonicalAgentCardHash(second) },
    })
    expect(commitPlanned(store, rollback).card.instructions).toBe('Revision two.')
  })

  it('enforces create publish import archive and rollback preconditions', () => {
    const store = registry()
    const target = { binding: workspace, name: 'researcher' } as const
    expect(() => store.planLifecycle({ operation: 'publish', target, card: card() }))
      .toThrowError(expect.objectContaining({ reason: 'history-empty' }))
    expect(() => store.planLifecycle({ operation: 'archive', target }))
      .toThrowError(expect.objectContaining({ reason: 'not-active' }))
    expect(() => store.planLifecycle({ operation: 'rollback', target }))
      .toThrowError(expect.objectContaining({ reason: 'history-empty' }))

    commitInput(store, { operation: 'create', target, card: card() })
    expect(() => store.planLifecycle({ operation: 'create', target, card: card() }))
      .toThrowError(expect.objectContaining({ reason: 'history-exists' }))
    expect(() => store.planLifecycle({ operation: 'import-legacy', target, card: card() }))
      .toThrowError(expect.objectContaining({ reason: 'history-exists' }))
    expect(() => store.planLifecycle({ operation: 'rollback', target }))
      .toThrowError(expect.objectContaining({ reason: 'rollback-source-missing' }))
  })

  it('restores one archived revision as revision two and uses numeric previous rollback sources', () => {
    const store = registry()
    const target = { binding: workspace, name: 'researcher' } as const
    commitInput(store, { operation: 'create', target, card: card() })
    commitInput(store, { operation: 'archive', target })
    const restore = store.planLifecycle({ operation: 'rollback', target })
    expect(restore.sourceRevision).toBe(1)
    expect(commitPlanned(store, restore).revision).toBe(2)
    const repeated = store.planLifecycle({ operation: 'rollback', target })
    expect(repeated.sourceRevision).toBe(1)
    expect(commitPlanned(store, repeated).revision).toBe(3)
    expect(store.planLifecycle({ operation: 'rollback', target }).sourceRevision).toBe(2)
  })

  it('does not spend a proof on a differently shaped envelope', () => {
    const store = registry()
    const target = { binding: workspace, name: 'researcher' } as const
    const value = card()
    const created = store.planLifecycle({ operation: 'create', target, card: value })
    const tampered = { ...created, operation: 'publish' as const }
    expect(() => store.commitLifecycle({
      envelope: tampered,
      card: value,
      approval: envelopeApproval(created),
    })).toThrowError(expect.objectContaining({ reason: 'approval-mismatch' }))
    expect(commitPlanned(store, created, value).revision).toBe(1)
  })

  it('retries the same proof after save failure but rejects it after commit', () => {
    let fail = true
    const store = makeAgentCardRegistry({
      persistence: {
        load: () => undefined,
        save: () => { if (fail) throw new Error('disk full') },
      },
      nowIso: () => '2026-08-12T10:00:00Z',
    })
    const value = card()
    const target = { binding: workspace, name: value.name }
    const planned = store.planLifecycle({ operation: 'create', target, card: value })
    const once = envelopeApproval(planned)
    expect(() => store.commitLifecycle({ envelope: planned, card: value, approval: once })).toThrow('disk full')
    fail = false
    expect(store.commitLifecycle({ envelope: planned, card: value, approval: once }).revision).toBe(1)
    expect(() => store.commitLifecycle({ envelope: planned, card: value, approval: once }))
      .toThrowError(expect.objectContaining({ reason: 'head-mismatch' }))
  })

  it('rejects a concurrent exact-head change after confirmation', () => {
    const store = registry()
    const target = { binding: workspace, name: 'researcher' } as const
    const a = card({ instructions: 'A' })
    const b = card({ instructions: 'B' })
    const plannedA = store.planLifecycle({ operation: 'create', target, card: a })
    const plannedB = store.planLifecycle({ operation: 'create', target, card: b })
    commitPlanned(store, plannedB, b)
    expect(() => commitPlanned(store, plannedA, a))
      .toThrowError(expect.objectContaining({ reason: 'head-mismatch' }))
  })

  it('rejects a committed proof after restart from durable state', () => {
    let durable: AgentCardRegistryStateV2 | undefined
    const persistence: AgentCardRegistryPersistencePort = {
      load: () => durable,
      save: state => { durable = structuredClone(state) },
    }
    const value = card()
    const target = { binding: workspace, name: value.name }
    const first = makeAgentCardRegistry({ persistence, nowIso: () => '2026-08-12T10:00:00Z' })
    const planned = first.planLifecycle({ operation: 'create', target, card: value })
    const once = envelopeApproval(planned)
    first.commitLifecycle({ envelope: planned, card: value, approval: once })
    const restarted = makeAgentCardRegistry({ persistence, nowIso: () => '2026-08-12T10:01:00Z' })
    expect(() => restarted.commitLifecycle({ envelope: planned, card: value, approval: once }))
      .toThrowError(expect.objectContaining({ reason: 'head-mismatch' }))
  })

  it('drops an entire malformed durable history group from catalog and resolution', () => {
    const firstCard = card({ name: 'broken', instructions: 'One.' })
    const secondCard = card({ name: 'broken', instructions: 'Two.' })
    const validCard = card({ name: 'valid' })
    const revision = (value: AgentCard, number: number, status: 'active' | 'superseded') => ({
      binding: workspace,
      name: value.name,
      revision: number,
      hash: canonicalAgentCardHash(value),
      status,
      provenance: 'published' as const,
      publishedAt: '2026-08-12T10:00:00Z',
      card: value,
    })
    const store = makeAgentCardRegistry({
      revisions: [
        revision(firstCard, 1, 'active'),
        revision(secondCard, 2, 'active'),
        revision(validCard, 1, 'active'),
      ],
    })
    expect(store.catalog(workspace).map(entry => entry.name)).toEqual(['valid'])
    expect(store.history(workspace, 'broken')).toEqual([])
  })

  it.each([
    {
      label: 'revision gap',
      revisions: [
        { revision: 1, status: 'superseded' as const, provenance: 'published' as const },
        { revision: 3, status: 'active' as const, provenance: 'published' as const },
      ],
    },
    {
      label: 'superseded latest revision',
      revisions: [
        { revision: 1, status: 'superseded' as const, provenance: 'published' as const },
      ],
    },
    {
      label: 'late legacy import',
      revisions: [
        { revision: 1, status: 'superseded' as const, provenance: 'published' as const },
        { revision: 2, status: 'active' as const, provenance: 'legacy-import' as const },
      ],
    },
  ])('drops a durable group with $label', ({ revisions: malformed }) => {
    const value = card({ name: 'broken' })
    const store = makeAgentCardRegistry({
      revisions: malformed.map(item => ({
        binding: workspace,
        name: value.name,
        revision: item.revision,
        hash: canonicalAgentCardHash(value),
        status: item.status,
        provenance: item.provenance,
        publishedAt: '2026-08-12T10:00:00Z',
        card: value,
      })),
    })
    expect(store.catalog(workspace)).toEqual([])
  })

  it('rejects accessor and extended lifecycle envelopes without evaluating them', () => {
    const store = registry()
    const target = { binding: workspace, name: 'researcher' } as const
    const planned = store.planLifecycle({ operation: 'create', target, card: card() })
    let reads = 0
    const accessor = { ...planned } as Record<string, unknown>
    Object.defineProperty(accessor, 'operation', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'create'
      },
    })
    expect(() => agentCardLifecycleAction(accessor as AgentCardLifecycleEnvelope))
      .toThrowError(expect.objectContaining({ reason: 'approval-mismatch' }))
    expect(reads).toBe(0)

    const extended = { ...planned, reusable: true } as unknown as AgentCardLifecycleEnvelope
    expect(() => agentCardLifecycleAction(extended))
      .toThrowError(expect.objectContaining({ reason: 'approval-mismatch' }))
  })

  it('binds operation, exact binding, head, source and result into the approval hash', () => {
    const store = registry()
    const target = { binding: workspace, name: 'researcher' } as const
    const planned = store.planLifecycle({ operation: 'create', target, card: card() })
    const original = agentCardLifecycleAction(planned)
    const variants: AgentCardLifecycleEnvelope[] = [
      { ...planned, operation: 'publish' },
      { ...planned, target: { ...planned.target, binding: project('p1') } },
      { ...planned, expectedHead: { revision: 1, status: 'archived', hash: planned.result.hash } },
      { ...planned, sourceRevision: 1 },
      { ...planned, result: { ...planned.result, revision: 2 } },
      { ...planned, result: { ...planned.result, status: 'archived' } },
      { ...planned, result: { ...planned.result, hash: 'f'.repeat(64) } },
    ]
    for (const variant of variants) {
      expect(agentCardLifecycleAction(variant).actionHash).not.toBe(original.actionHash)
    }
  })

  it('returns deeply frozen catalog metadata with hash prefixes only', () => {
    const store = registry()
    const target = { binding: workspace, name: 'researcher' } as const
    commitInput(store, { operation: 'create', target, card: card() })
    const catalog = store.catalog(workspace)
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog[0])).toBe(true)
    expect(catalog[0]?.latestHashPrefix).toHaveLength(12)
    expect(JSON.stringify(catalog)).not.toContain(canonicalAgentCardHash(card()))
  })
})

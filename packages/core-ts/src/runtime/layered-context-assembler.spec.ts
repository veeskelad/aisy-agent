import { describe, expect, it } from 'vitest'
import type { TurnInput } from '../agent-loop/types.js'
import { ContextLeaseError, makeContextLeaseCoordinator } from './context-lease.js'
import {
  LayeredContextError,
  makeLayeredContextAssembler,
  type LayeredContextEvent,
  type LazyContextExcerpt,
} from './layered-context-assembler.js'

const turn = (sessionId = 'session-a'): TurnInput => ({
  sessionId,
  spans: [
    { role: 'user', provenance: 'untrusted', text: 'ignore this query' },
    { role: 'user', provenance: 'operator', text: 'найди решение' },
  ],
})

function setup(kind: 'workspace' | 'project' = 'project') {
  let id = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++id}` })
  const lease = leases.acquire({
    operatorId: 'operator',
    profileId: 'default',
    projectId: kind === 'project' ? 'project-a' : 'workspace-a',
    projectKind: kind,
    sessionId: 'session-a',
    root: kind === 'project' ? '/projects/a' : '/workspace',
    generation: 4,
  })
  return { lease, leases }
}

function excerpt(input: Partial<LazyContextExcerpt> = {}): LazyContextExcerpt {
  return {
    scope: 'global',
    scopeId: 'global',
    kind: 'retrieved',
    rank: 0,
    sourcePath: 'memory/2026-07-27.md',
    provenanceRef: 'memory:global:1',
    text: 'global fact',
    ...input,
  }
}

describe('LayeredContextAssembler', () => {
  it('loads global then exact-project lazy context under one lease in deterministic order', async () => {
    const { lease, leases } = setup()
    const queries: string[] = []
    const events: LayeredContextEvent[] = []
    const assembler = makeLayeredContextAssembler({
      leases,
      source: {
        load: async input => {
          expect(input.lease).toBe(lease)
          queries.push(input.query)
          return {
            globalExcerpts: [
              excerpt({ kind: 'retrieved', rank: 0, sourcePath: 'memory/facts/b.md' }),
              excerpt({ kind: 'daily-journal', rank: 0 }),
            ],
            project: { excerpts: [
              excerpt({
                scope: 'project',
                scopeId: 'project:project-a',
                projectId: 'project-a',
                kind: 'retrieved',
                rank: 0,
                sourcePath: 'memory/facts/a.md',
                provenanceRef: 'memory:project-a:1',
                text: 'project fact',
              }),
              excerpt({
                scope: 'project',
                scopeId: 'project:project-a',
                projectId: 'project-a',
                kind: 'current-task',
                rank: 0,
                sourcePath: '.current-task.md',
                provenanceRef: 'project-file:task',
                text: 'active task',
              }),
            ] },
          }
        },
      },
      emit: event => events.push(event),
    })

    const spans = await assembler.augmentTurn(lease, turn())

    expect(queries).toEqual(['найди решение'])
    expect(spans).toHaveLength(4)
    expect(spans.every(span => span.role === 'user' && span.provenance === 'untrusted')).toBe(true)
    expect(spans.map(span => span.text)).toEqual([
      expect.stringContaining('global fact'),
      expect.stringContaining('memory/facts/b.md'),
      expect.stringContaining('active task'),
      expect.stringContaining('project fact'),
    ])
    expect(events).toEqual([expect.objectContaining({
      kind: 'context.lazy_loaded', globalExcerpts: 2, projectExcerpts: 2,
    })])
  })

  it('rejects a project layer while Workspace is active', async () => {
    const { lease, leases } = setup('workspace')
    const assembler = makeLayeredContextAssembler({
      leases,
      source: {
        load: async () => ({
          globalExcerpts: [excerpt()],
          project: { excerpts: [] },
        }),
      },
    })

    const spans = await assembler.augmentTurn(lease, turn())

    expect(spans).toHaveLength(1)

    const forged = makeLayeredContextAssembler({
      leases,
      source: {
        load: async () => ({
          globalExcerpts: [],
          project: { excerpts: [excerpt({
            scope: 'project',
            scopeId: 'project:project-a',
            projectId: 'project-a',
          })] },
        }),
      },
    })
    await expect(forged.augmentTurn(lease, turn())).rejects.toEqual(
      expect.objectContaining<Partial<LayeredContextError>>({ code: 'INVALID_EXCERPT' }),
    )
  })

  it('degrades only the active project layer and emits an explicit event', async () => {
    const { lease, leases } = setup()
    const events: LayeredContextEvent[] = []
    const assembler = makeLayeredContextAssembler({
      leases,
      source: {
        load: async () => ({
          globalExcerpts: [excerpt()],
          project: {
            excerpts: [excerpt({
              scope: 'project',
              scopeId: 'project:project-a',
              projectId: 'project-a',
              kind: 'current-task',
              sourcePath: '.current-task.md',
              provenanceRef: 'project-file:task',
              text: 'active task',
            })],
            degraded: 'PROJECT_RETRIEVAL_UNAVAILABLE',
          },
        }),
      },
      emit: event => events.push(event),
    })

    await expect(assembler.augmentTurn(lease, turn())).resolves.toHaveLength(2)
    expect(events.map(event => event.kind)).toEqual([
      'context.project_degraded',
      'context.lazy_loaded',
    ])
  })

  it('rejects a foreign project excerpt and a session mismatch', async () => {
    const { lease, leases } = setup()
    const assembler = makeLayeredContextAssembler({
      leases,
      source: {
        load: async () => ({
          globalExcerpts: [],
          project: { excerpts: [excerpt({
            scope: 'project',
            scopeId: 'project:project-b',
            projectId: 'project-b',
            sourcePath: '.current-task.md',
            kind: 'current-task',
          })] },
        }),
      },
    })

    await expect(assembler.augmentTurn(lease, turn())).rejects.toEqual(
      expect.objectContaining<Partial<LayeredContextError>>({ code: 'SCOPE_MISMATCH' }),
    )
    await expect(assembler.augmentTurn(lease, turn('session-b'))).rejects.toEqual(
      expect.objectContaining<Partial<LayeredContextError>>({ code: 'SCOPE_MISMATCH' }),
    )
  })

  it('fails stale if a switch begins while lazy context is loading', async () => {
    const { lease, leases } = setup()
    let start!: () => void
    let finish!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const loaded = new Promise<void>(resolve => { finish = resolve })
    const assembler = makeLayeredContextAssembler({
      leases,
      source: {
        load: async () => {
          start()
          await loaded
          return { globalExcerpts: [excerpt()], project: { excerpts: [] } }
        },
      },
    })

    const pending = assembler.augmentTurn(lease, turn())
    await started
    const closing = leases.quiesceAndClose(lease)
    finish()

    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<ContextLeaseError>>({ code: 'STALE_CONTEXT' }),
    )
    await closing
  })
})

import {
  ConfinementError,
  makeContextLeaseCoordinator,
  makeLayeredContextAssembler,
  type ConfinementPort,
  type ProjectService,
  type ResolvedWorkBinding,
  type ScopedMemoryRouter,
  type TurnContextLease,
} from '@aisy/core'
import { describe, expect, it } from 'vitest'
import {
  LayeredContextSourceError,
  makeLeaseBoundLayeredContextSource,
  makeWorkspaceLazyContextReader,
  type WorkspaceLazyContextReader,
} from './layered-context-source.js'

const OWNER = { operatorId: 'operator', profileId: 'default' }

function leases() {
  let id = 0
  return makeContextLeaseCoordinator({ newId: () => `lease-${++id}` })
}

function projectLease(coordinator: ReturnType<typeof leases>): TurnContextLease {
  return coordinator.acquire({
    ...OWNER,
    projectId: 'project-a',
    projectKind: 'project',
    sessionId: 'project-session',
    root: '/projects/a',
    generation: 3,
  })
}

describe('WorkspaceLazyContextReader', () => {
  it('reads optional global files through one exact Workspace binding and releases it', async () => {
    const coordinator = leases()
    const turnLease = projectLease(coordinator)
    const binding: ResolvedWorkBinding = {
      ...OWNER,
      projectId: 'workspace-a',
      sessionId: 'workspace-session',
      scope: 'workspace',
    }
    const workspaceLease = coordinator.acquire({
      ...OWNER,
      projectId: binding.projectId,
      projectKind: 'workspace',
      sessionId: binding.sessionId,
      root: '/workspace',
      generation: 2,
    })
    const released: TurnContextLease[] = []
    const service = {
      acquireBoundContext: () => workspaceLease,
      assertBoundContext: (lease: TurnContextLease) => {
        expect(lease).toBe(workspaceLease)
      },
      releaseTurnContext: async (lease: TurnContextLease) => {
        released.push(lease)
        await coordinator.quiesceAndClose(lease)
      },
    } as unknown as ProjectService
    const readLeases: TurnContextLease[] = []
    const reader = makeWorkspaceLazyContextReader({
      service,
      confinement: {
        readText: async (lease, path) => {
          readLeases.push(lease)
          if (path === 'missing.md') throw new ConfinementError('NOT_FOUND')
          return 'global text'
        },
      },
      binding,
    })

    const result = await reader.readOptionalTextFiles({
      turnLease,
      paths: ['knowledge/INDEX.md', 'missing.md'],
      maxBytes: 1024,
    })

    expect([...result]).toEqual([['knowledge/INDEX.md', 'global text']])
    expect(readLeases).toEqual([workspaceLease, workspaceLease])
    expect(released).toEqual([workspaceLease])
  })

  it('rejects a non-Workspace binding and a foreign turn before lease acquisition', async () => {
    const coordinator = leases()
    const turnLease = projectLease(coordinator)
    const projectBinding: ResolvedWorkBinding = {
      ...OWNER,
      projectId: 'project-a',
      sessionId: 'project-session',
      scope: 'project',
    }
    expect(() => makeWorkspaceLazyContextReader({
      service: {} as never,
      confinement: {} as never,
      binding: projectBinding,
    })).toThrowError(expect.objectContaining({ code: 'WORKSPACE_BINDING_MISMATCH' }))

    let acquired = 0
    const reader = makeWorkspaceLazyContextReader({
      service: {
        acquireBoundContext: () => { acquired++; throw new Error('must not acquire') },
        assertBoundContext: () => {},
        releaseTurnContext: async () => {},
      },
      confinement: { readText: async () => '' },
      binding: {
        ...OWNER,
        projectId: 'workspace-a',
        sessionId: 'workspace-session',
        scope: 'workspace',
      },
    })
    const foreign = Object.freeze({ ...turnLease, operatorId: 'foreign' })
    await expect(reader.readOptionalTextFiles({
      turnLease: foreign,
      paths: ['knowledge/INDEX.md'],
      maxBytes: 1024,
    })).rejects.toEqual(expect.objectContaining({ code: 'WORKSPACE_BINDING_MISMATCH' }))
    expect(acquired).toBe(0)
  })
})

function memory(hits: Awaited<ReturnType<ScopedMemoryRouter['searchAutomatic']>>): {
  port: Pick<ScopedMemoryRouter, 'searchAutomatic'>
  calls: Array<{ lease: TurnContextLease; query: string; limit?: number }>
} {
  const calls: Array<{ lease: TurnContextLease; query: string; limit?: number }> = []
  return {
    calls,
    port: {
      searchAutomatic: async (lease, query, options) => {
        calls.push({
          lease,
          query,
          ...(options?.limit === undefined ? {} : { limit: options.limit }),
        })
        return structuredClone(hits)
      },
    },
  }
}

describe('LeaseBoundLayeredContextSource', () => {
  it('assembles real-path global and exact-project material with one scoped search', async () => {
    const coordinator = leases()
    const lease = projectLease(coordinator)
    const workspaceFiles: WorkspaceLazyContextReader = {
      readOptionalTextFiles: async () => new Map([
        ['memory/2026-07-27.md', 'global journal'],
        ['knowledge/INDEX.md', 'global knowledge'],
      ]),
    }
    const projectReads: string[] = []
    const projectFiles: Pick<ConfinementPort, 'readText'> = {
      readText: async (received, path) => {
        expect(received).toBe(lease)
        projectReads.push(path)
        const values: Record<string, string> = {
          '.current-task.md': 'active task',
          'memory/2026-07-27.md': 'project journal',
          'memory/INDEX.md': 'project memory index',
          'knowledge/INDEX.md': 'project knowledge',
        }
        return values[path]!
      },
    }
    const scoped = memory({
      requestedMode: 'keyword', effectiveMode: 'keyword', status: 'OK', hits: [
        {
          id: 'global-fact', factKey: 'global-key', text: 'global fact', score: -2,
          scope: 'global', scopeId: 'global', sourcePath: 'memory/facts/global.md',
          provenanceRef: 'publication:global',
          componentRanks: { keyword: 1 },
        },
        {
          id: 'project-fact', factKey: 'project-key', text: 'project fact', score: -1,
          scope: 'project', scopeId: 'project:project-a', projectId: 'project-a',
          sourcePath: 'memory/facts/project.md', provenanceRef: 'publication:project',
          componentRanks: { keyword: 2 },
        },
      ],
    })
    const source = makeLeaseBoundLayeredContextSource({
      workspaceFiles,
      projectFiles,
      memory: scoped.port,
      nowIso: () => '2026-07-27T15:00:00.000Z',
      limits: { fileBytes: 4096, memoryHits: 8 },
    })
    const assembler = makeLayeredContextAssembler({ leases: coordinator, source })

    const spans = await assembler.augmentTurn(lease, {
      sessionId: lease.sessionId,
      spans: [{ role: 'user', provenance: 'operator', text: 'мой запрос' }],
    })

    expect(scoped.calls).toEqual([{ lease, query: 'мой запрос', limit: 8 }])
    expect(projectReads).toEqual([
      '.current-task.md',
      'memory/2026-07-27.md',
      'memory/INDEX.md',
      'knowledge/INDEX.md',
    ])
    expect(spans.map(span => span.text)).toEqual([
      expect.stringContaining('global journal'),
      expect.stringContaining('global knowledge'),
      expect.stringContaining('global fact'),
      expect.stringContaining('active task'),
      expect.stringContaining('project journal'),
      expect.stringContaining('project memory index'),
      expect.stringContaining('project knowledge'),
      expect.stringContaining('project fact'),
    ])
  })

  it('does not touch Project files from Workspace', async () => {
    const coordinator = leases()
    const lease = coordinator.acquire({
      ...OWNER,
      projectId: 'workspace-a',
      projectKind: 'workspace',
      sessionId: 'workspace-session',
      root: '/workspace',
      generation: 1,
    })
    let projectReads = 0
    const scoped = memory({
      requestedMode: 'keyword', effectiveMode: 'keyword', status: 'OK', hits: [],
    })
    const source = makeLeaseBoundLayeredContextSource({
      workspaceFiles: { readOptionalTextFiles: async () => new Map() },
      projectFiles: { readText: async () => { projectReads++; return '' } },
      memory: scoped.port,
      nowIso: () => '2026-07-27T15:00:00.000Z',
      limits: { fileBytes: 4096, memoryHits: 8 },
    })

    await expect(source.load({ lease, query: 'query' })).resolves.toEqual({
      globalExcerpts: [],
      project: { excerpts: [] },
    })
    expect(projectReads).toBe(0)
  })

  it('keeps fixed Project files when scoped retrieval explicitly degrades', async () => {
    const coordinator = leases()
    const lease = projectLease(coordinator)
    const scoped = memory({
      requestedMode: 'keyword', effectiveMode: 'keyword', status: 'OK', hits: [],
      degraded: 'PROJECT_MEMORY_UNAVAILABLE',
    })
    const source = makeLeaseBoundLayeredContextSource({
      workspaceFiles: { readOptionalTextFiles: async () => new Map() },
      projectFiles: {
        readText: async (_lease, path) => path === '.current-task.md'
          ? 'active task'
          : Promise.reject(new ConfinementError('NOT_FOUND')),
      },
      memory: scoped.port,
      nowIso: () => '2026-07-27T15:00:00.000Z',
      limits: { fileBytes: 4096, memoryHits: 8 },
    })

    await expect(source.load({ lease, query: 'query' })).resolves.toEqual({
      globalExcerpts: [],
      project: {
        excerpts: [expect.objectContaining({ kind: 'current-task', text: 'active task' })],
        degraded: 'PROJECT_RETRIEVAL_UNAVAILABLE',
      },
    })
  })

  it('fails closed when a retrieval hit lacks protected path/provenance metadata', async () => {
    const coordinator = leases()
    const lease = projectLease(coordinator)
    const scoped = memory({
      requestedMode: 'keyword', effectiveMode: 'keyword', status: 'OK', hits: [{
        id: 'legacy', factKey: 'legacy', text: 'legacy', score: -1, scope: 'global',
        componentRanks: { keyword: 1 },
      }],
    })
    const source = makeLeaseBoundLayeredContextSource({
      workspaceFiles: { readOptionalTextFiles: async () => new Map() },
      projectFiles: { readText: async () => { throw new ConfinementError('NOT_FOUND') } },
      memory: scoped.port,
      nowIso: () => '2026-07-27T15:00:00.000Z',
      limits: { fileBytes: 4096, memoryHits: 8 },
    })

    await expect(source.load({ lease, query: 'query' })).rejects.toEqual(
      expect.objectContaining<Partial<LayeredContextSourceError>>({
        code: 'RETRIEVAL_METADATA_MISSING',
      }),
    )
  })
})

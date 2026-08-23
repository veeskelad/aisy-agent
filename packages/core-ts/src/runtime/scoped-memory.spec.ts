import { describe, expect, it } from 'vitest'
import { ForgetListTamperError, type Memory, type MemoryOp, type RankedHit } from '../memory/index.js'
import { makeContextLeaseCoordinator } from './context-lease.js'
import {
  makeScopedMemoryRouter,
  ScopedMemoryError,
  type ScopedMemoryEvent,
} from './scoped-memory.js'

function fakeMemory(input: {
  hits?: RankedHit[]
  onSearch?: (query: string) => void
  onCommit?: (op: MemoryOp) => void
  failSearch?: boolean
  searchError?: Error
} = {}): Memory {
  return {
    search: async (query) => {
      input.onSearch?.(query)
      if (input.searchError) throw input.searchError
      if (input.failSearch) throw new Error('index unavailable')
      return input.hits ?? []
    },
    load: async () => '',
    listLive: async () => [],
    readFrozenSnapshot: async () => ({ bytes: Buffer.alloc(0), sha256: '' }),
    commit: async (op) => {
      input.onCommit?.(op)
      return { status: 'COMMITTED', factId: 'fact-new' }
    },
    forget: async () => {},
    reindex: async () => {},
    rebuildFromFiles: async () => {},
    serializeMemoryIndex: async () => ({ content: '', sha256: '' }),
    integrityCheck: async () => ({ ok: true }),
  }
}

function lease(kind: 'workspace' | 'project' = 'project') {
  let id = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-id-${++id}` })
  const value = leases.acquire({
    operatorId: 'telegram:42',
    profileId: 'default',
    projectId: kind === 'workspace' ? 'workspace-1' : 'project-a',
    projectKind: kind,
    sessionId: 'session-1',
    root: kind === 'workspace' ? '/Users/operator/workspace' : '/Users/operator/projects/a',
    generation: 1,
  })
  return { leases, value }
}

describe('ScopedMemoryRouter', () => {
  it('searches only global memory from Workspace context', async () => {
    const context = lease('workspace')
    const resolved: string[] = []
    const router = makeScopedMemoryRouter({
      leases: context.leases,
      globalMemory: fakeMemory({ hits: [{ id: 'g', factKey: 'gk', text: 'global', score: -1 }] }),
      projectMemory: (projectId) => { resolved.push(projectId); return null },
    })

    const result = await router.searchAutomatic(context.value, 'query')

    expect(result).toMatchObject({
      requestedMode: 'hybrid', effectiveMode: 'keyword',
      status: 'SEMANTIC_UNAVAILABLE', semanticDegraded: 'SEMANTIC_UNAVAILABLE',
    })
    expect(result.hits).toEqual([expect.objectContaining({ id: 'g', scope: 'global' })])
    expect(result.degraded).toBeUndefined()
    expect(resolved).toEqual([])
  })

  it('searches global plus only the exact leased Project and labels every hit', async () => {
    const context = lease('project')
    const resolved: string[] = []
    const router = makeScopedMemoryRouter({
      leases: context.leases,
      globalMemory: fakeMemory({ hits: [{ id: 'g', factKey: 'gk', text: 'global', score: -1 }] }),
      projectMemory: (projectId) => {
        resolved.push(projectId)
        return fakeMemory({ hits: [{ id: 'p', factKey: 'pk', text: 'project', score: -2 }] })
      },
    })

    const result = await router.searchAutomatic(context.value, 'query')

    expect(resolved).toEqual(['project-a'])
    expect(result.hits).toEqual([
      expect.objectContaining({ id: 'p', scope: 'project', projectId: 'project-a' }),
      expect.objectContaining({ id: 'g', scope: 'global' }),
    ])
  })

  it('reports explicit keyword-only semantics for every requested mode', async () => {
    const context = lease('workspace')
    let searches = 0
    const router = makeScopedMemoryRouter({
      leases: context.leases,
      globalMemory: fakeMemory({
        hits: [{ id: 'g', factKey: 'gk', text: 'global', score: -1 }],
        onSearch: () => { searches += 1 },
      }),
      projectMemory: () => null,
    })

    await expect(router.searchAutomatic(context.value, 'q', { mode: 'keyword' }))
      .resolves.toMatchObject({
        requestedMode: 'keyword', effectiveMode: 'keyword', status: 'OK',
        hits: [expect.objectContaining({ componentRanks: { keyword: 1 } })],
      })
    await expect(router.searchAutomatic(context.value, 'q', { mode: 'semantic' }))
      .resolves.toMatchObject({
        requestedMode: 'semantic', effectiveMode: 'none',
        status: 'SEMANTIC_UNAVAILABLE', hits: [],
      })
    expect(searches).toBe(1)
  })

  it('degrades to global-only without consulting another Project index', async () => {
    const context = lease('project')
    const resolved: string[] = []
    const events: ScopedMemoryEvent[] = []
    const router = makeScopedMemoryRouter({
      leases: context.leases,
      globalMemory: fakeMemory({ hits: [{ id: 'g', factKey: 'gk', text: 'global', score: -1 }] }),
      projectMemory: (projectId) => { resolved.push(projectId); return null },
      emit: (event) => events.push(event),
    })

    const result = await router.searchAutomatic(context.value, 'query')

    expect(result.hits.map((hit) => hit.id)).toEqual(['g'])
    expect(result.degraded).toBe('PROJECT_MEMORY_UNAVAILABLE')
    expect(resolved).toEqual(['project-a'])
    expect(events).toEqual([expect.objectContaining({
      kind: 'memory.scope_degraded',
      projectId: 'project-a',
      generation: 1,
    })])
  })

  it('routes project writes from the lease and rejects them in Workspace', async () => {
    const projectContext = lease('project')
    const workspaceContext = lease('workspace')
    const commits: MemoryOp[] = []
    const router = makeScopedMemoryRouter({
      leases: projectContext.leases,
      globalMemory: fakeMemory(),
      projectMemory: (projectId) => projectId === 'project-a'
        ? fakeMemory({ onCommit: (op) => commits.push(op) })
        : null,
    })
    await router.commitProject(
      projectContext.value,
      { op: 'ADD', text: 'project fact' },
      { withinSession: true },
    )

    expect(commits).toEqual([{ op: 'ADD', text: 'project fact' }])
    const workspaceRouter = makeScopedMemoryRouter({
      leases: workspaceContext.leases,
      globalMemory: fakeMemory(),
      projectMemory: () => { throw new Error('must not resolve') },
    })
    await expect(workspaceRouter.commitProject(
      workspaceContext.value,
      { op: 'ADD', text: 'wrong scope' },
      { withinSession: true },
    )).rejects.toThrowError(expect.objectContaining({ code: 'PROJECT_SCOPE_REQUIRED' }))
  })

  it('rejects a closed lease before touching memory', async () => {
    const context = lease('project')
    let touched = false
    const router = makeScopedMemoryRouter({
      leases: context.leases,
      globalMemory: fakeMemory({ onSearch: () => { touched = true } }),
      projectMemory: () => fakeMemory(),
    })
    await context.leases.quiesceAndClose(context.value)

    await expect(router.searchAutomatic(context.value, 'query')).rejects.toThrowError(
      expect.objectContaining({ code: 'STALE_CONTEXT' }),
    )
    expect(touched).toBe(false)
  })

  it('propagates global-memory failure instead of serving an identity-less turn', async () => {
    const context = lease('project')
    const router = makeScopedMemoryRouter({
      leases: context.leases,
      globalMemory: fakeMemory({ failSearch: true }),
      projectMemory: () => fakeMemory(),
    })

    await expect(router.searchAutomatic(context.value, 'query')).rejects.toThrow('index unavailable')
  })

  it('never degrades past a project forget-ledger integrity failure', async () => {
    const context = lease('project')
    const events: ScopedMemoryEvent[] = []
    const router = makeScopedMemoryRouter({
      leases: context.leases,
      globalMemory: fakeMemory(),
      projectMemory: () => fakeMemory({
        searchError: new ForgetListTamperError('hash chain break'),
      }),
      emit: (event) => events.push(event),
    })

    await expect(router.searchAutomatic(context.value, 'query')).rejects.toThrow(ForgetListTamperError)
    expect(events).toEqual([])
  })
})

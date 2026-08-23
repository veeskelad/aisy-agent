import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeContextLeaseCoordinator, type TurnContextLease } from './context-lease.js'
import type { HybridRetrievalHit, HybridRetrievalMode } from './hybrid-retrieval.js'
import type { ProjectRecordV2 } from './project-registry-v2.js'
import {
  CrossProjectSearchError,
  crossProjectQueryHash,
  makeCrossProjectSearchAuthority,
  makeWorkspaceProjectSearch,
  type CrossProjectNonceRecord,
  type CrossProjectSearchAuthority,
  type CrossProjectSearchBinding,
  type CrossProjectSearchIndex,
} from './cross-project-search.js'

const QUERY = '  Общий   Поиск  '
const OPTIONS = {
  mode: 'hybrid' as const,
  includeArchived: false,
  limitPerProject: 2,
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function project(id: string, name: string, archived = false): ProjectRecordV2 {
  return {
    id,
    operatorId: 'telegram:42',
    profileId: 'default',
    kind: 'project',
    origin: 'registered',
    name,
    root: `/Users/operator/projects/${id}`,
    createdAt: '2026-07-27T00:00:00.000Z',
    ...(archived ? { archivedAt: '2026-07-27T01:00:00.000Z' } : {}),
  }
}

function hit(projectId: string, path: string, content: string, score = 1): HybridRetrievalHit {
  return {
    hitId: `${projectId}:${path}`,
    scope: 'project',
    scopeId: `project:${projectId}`,
    projectId,
    sourcePath: path,
    chunkId: 'chunk-1',
    contentHash: hash(content),
    provenance: `journal:${projectId}`,
    score,
    componentRanks: { keyword: 1, semantic: 1 },
  }
}

function binding(
  lease: TurnContextLease,
  query = QUERY,
  options: { mode: HybridRetrievalMode; includeArchived: boolean; limitPerProject: number } = OPTIONS,
): CrossProjectSearchBinding {
  return {
    operatorId: lease.operatorId,
    profileId: lease.profileId,
    workspaceProjectId: lease.projectId,
    workspaceSessionId: lease.sessionId,
    generation: lease.generation,
    queryHash: crossProjectQueryHash(query),
    mode: options.mode,
    includeArchived: options.includeArchived,
    limitPerProject: options.limitPerProject,
  }
}

function setup(input: {
  projects?: ProjectRecordV2[]
  hits?: Record<string, HybridRetrievalHit[]>
  missing?: string[]
  readContent?: Record<string, string>
  maxProjects?: number
} = {}) {
  let id = 0
  let now = Date.parse('2026-07-27T12:00:00.000Z')
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++id}` })
  const lease = leases.acquire({
    operatorId: 'telegram:42',
    profileId: 'default',
    projectId: 'workspace-1',
    projectKind: 'workspace',
    sessionId: 'workspace-session',
    root: '/Users/operator/workspace',
    generation: 7,
  })
  const nonces = new Map<string, CrossProjectNonceRecord>()
  const consumed: string[] = []
  const authority = makeCrossProjectSearchAuthority({
    secret: Buffer.alloc(32, 9),
    nowMs: () => now,
    newId: () => `authority-${++id}`,
    nonces: {
      issue: (record) => nonces.set(`${record.kind}:${record.id}`, { ...record }),
      consume: (nonceId, kind, mac) => {
        const key = `${kind}:${nonceId}`
        const record = nonces.get(key)
        if (!record || record.mac !== mac) return false
        nonces.delete(key)
        consumed.push(key)
        return true
      },
    },
  })
  const projects = input.projects ?? [project('project-b', 'B'), project('project-a', 'A')]
  const calls: string[] = []
  const defaultHits: Record<string, HybridRetrievalHit[]> = {
    'project-a': [
      hit('project-a', 'docs/a1.md', 'A1'),
      { ...hit('project-a', 'docs/a2.md', 'A2'), chunkId: 'chunk-2' },
    ],
    'project-b': [hit('project-b', 'docs/b1.md', 'B1')],
  }
  const allHits = input.hits ?? defaultHits
  const index = (projectId: string): CrossProjectSearchIndex | null => {
    calls.push(`resolve:${projectId}`)
    if (input.missing?.includes(projectId)) return null
    return {
      search: async (query, options) => {
        calls.push(`search:${projectId}:${query}:${options.mode}:${options.limit}`)
        return { hits: allHits[projectId] ?? [] }
      },
    }
  }
  const service = makeWorkspaceProjectSearch({
    leases,
    authority,
    listProjects: (_owner, includeArchived) => {
      calls.push(`list:${includeArchived}`)
      return projects.map((value) => ({ ...value }))
    },
    projectIndex: index,
    readExcerpt: async (request) => {
      calls.push(`read:${request.projectId}:${request.sourcePath}:${request.chunkId}`)
      const content = input.readContent?.[request.contentHash] ?? {
        [hash('A1')]: 'A1',
        [hash('A2')]: 'A2',
        [hash('B1')]: 'B1',
        [hash('C1')]: 'C1',
      }[request.contentHash] ?? ''
      return { content, contentHash: hash(content) }
    },
    maxProjects: input.maxProjects ?? 10,
    maxExcerptBytes: 1024,
    capabilityTtlMs: 30_000,
  })
  const issue = (
    query = QUERY,
    options: { mode: HybridRetrievalMode; includeArchived: boolean; limitPerProject: number } = OPTIONS,
  ) => authority.issueSearch({
    source: 'operator',
    nested: false,
    binding: binding(lease, query, options),
    ttlMs: 30_000,
  })
  return {
    authority,
    calls,
    consumed,
    issue,
    lease,
    leases,
    nonces,
    service,
    advance: (milliseconds: number) => { now += milliseconds },
  }
}

describe('WorkspaceProjectSearch', () => {
  it('normalizes the query hash without widening the raw query sent to each index', async () => {
    const state = setup()
    expect(crossProjectQueryHash(' ОБЩИЙ\nПОИСК ')).toBe(crossProjectQueryHash(QUERY))
    const normalizedVariant = 'ОБЩИЙ\nПОИСК'

    await state.service.searchAllProjects(
      state.lease,
      state.issue(QUERY),
      normalizedVariant,
      OPTIONS,
    )

    expect(state.calls).toContain(`search:project-a:${normalizedVariant}:hybrid:2`)
  })

  it('fans out only to isolated active project indexes and merges by stable per-project rank', async () => {
    const archived = project('project-c', 'C', true)
    const state = setup({ projects: [archived, project('project-b', 'B'), project('project-a', 'A')] })

    const results = await state.service.searchAllProjects(
      state.lease,
      state.issue(),
      QUERY,
      OPTIONS,
    )

    expect(state.calls).toEqual([
      'list:false',
      'resolve:project-a', `search:project-a:${QUERY}:hybrid:2`,
      'resolve:project-b', `search:project-b:${QUERY}:hybrid:2`,
    ])
    expect(results.map((value) => [value.projectId, value.projectRank])).toEqual([
      ['project-a', 1],
      ['project-b', 1],
      ['project-a', 2],
    ])
    expect(results[0]).toMatchObject({
      projectId: 'project-a',
      projectName: 'A',
      sourcePath: 'docs/a1.md',
      readCapability: { projectId: 'project-a', sourcePath: 'docs/a1.md' },
    })
  })

  it('opens only the exact capability-bound excerpt and consumes it once', async () => {
    const state = setup()
    const [first] = await state.service.searchAllProjects(state.lease, state.issue(), QUERY, OPTIONS)

    await expect(state.service.openSearchHit(state.lease, first!.readCapability)).resolves.toBe('A1')
    await expect(state.service.openSearchHit(state.lease, first!.readCapability)).rejects.toThrowError(
      expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }),
    )
    expect(state.calls).toContain('read:project-a:docs/a1.md:chunk-1')
  })

  it('binds query, mode, archive flag and per-project limit before consuming the receipt', async () => {
    const state = setup()
    const receipt = state.issue()
    const variants = [
      { query: 'another', options: OPTIONS },
      { query: QUERY, options: { ...OPTIONS, mode: 'keyword' as const } },
      { query: QUERY, options: { ...OPTIONS, includeArchived: true } },
      { query: QUERY, options: { ...OPTIONS, limitPerProject: 1 } },
    ]
    for (const value of variants) {
      await expect(state.service.searchAllProjects(
        state.lease,
        receipt,
        value.query,
        value.options,
      )).rejects.toThrowError(expect.objectContaining({ code: 'BINDING_MISMATCH' }))
    }
    expect(state.consumed).toEqual([])
    await state.service.searchAllProjects(state.lease, receipt, QUERY, OPTIONS)
    await expect(state.service.searchAllProjects(state.lease, receipt, QUERY, OPTIONS)).rejects
      .toThrowError(expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }))
  })

  it('excludes archived projects unless the operator receipt explicitly binds includeArchived', async () => {
    const archived = project('project-c', 'C', true)
    const state = setup({
      projects: [project('project-a', 'A'), archived],
      hits: {
        'project-a': [hit('project-a', 'docs/a1.md', 'A1')],
        'project-c': [hit('project-c', 'docs/c1.md', 'C1')],
      },
    })
    const options = { ...OPTIONS, includeArchived: true }

    const results = await state.service.searchAllProjects(
      state.lease,
      state.issue(QUERY, options),
      QUERY,
      options,
    )

    expect(results.map((value) => value.projectId)).toEqual(['project-a', 'project-c'])
  })

  it('requires an operator-origin, non-nested issuance and a Workspace lease', async () => {
    const state = setup()
    expect(() => state.authority.issueSearch({
      source: 'model',
      nested: false,
      binding: binding(state.lease),
      ttlMs: 30_000,
    } as unknown as Parameters<CrossProjectSearchAuthority['issueSearch']>[0])).toThrowError(
      expect.objectContaining({ code: 'OPERATOR_ORIGIN_REQUIRED' }),
    )
    expect(() => state.authority.issueSearch({
      source: 'operator',
      nested: true,
      binding: binding(state.lease),
      ttlMs: 30_000,
    } as unknown as Parameters<CrossProjectSearchAuthority['issueSearch']>[0])).toThrowError(
      expect.objectContaining({ code: 'NESTED_REQUEST_DENIED' }),
    )
    const projectLease = state.leases.acquire({
      operatorId: state.lease.operatorId,
      profileId: state.lease.profileId,
      projectId: 'project-a',
      projectKind: 'project',
      sessionId: 'session-a',
      root: '/Users/operator/projects/a',
      generation: state.lease.generation,
    })
    await expect(state.service.searchAllProjects(projectLease, state.issue(), QUERY, OPTIONS))
      .rejects.toThrowError(expect.objectContaining({ code: 'WORKSPACE_LEASE_REQUIRED' }))
    expect(state.consumed).toEqual([])
  })

  it('fails hard on cross-scope hits and unsafe index-provided paths', async () => {
    const crossScope = setup({
      projects: [project('project-a', 'A')],
      hits: { 'project-a': [hit('project-b', 'docs/wrong.md', 'wrong')] },
    })
    await expect(crossScope.service.searchAllProjects(
      crossScope.lease,
      crossScope.issue(),
      QUERY,
      OPTIONS,
    )).rejects.toThrowError(expect.objectContaining({ code: 'CROSS_SCOPE_HIT' }))

    const traversal = setup({
      projects: [project('project-a', 'A')],
      hits: { 'project-a': [hit('project-a', '../secret', 'wrong')] },
    })
    await expect(traversal.service.searchAllProjects(
      traversal.lease,
      traversal.issue(),
      QUERY,
      OPTIONS,
    )).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_HIT' }))
  })

  it('rejects duplicate chunks from a non-conforming project index', async () => {
    const duplicate = hit('project-a', 'docs/a.md', 'A1')
    const state = setup({
      projects: [project('project-a', 'A')],
      hits: { 'project-a': [duplicate, { ...duplicate, hitId: 'other' }] },
    })

    await expect(state.service.searchAllProjects(
      state.lease,
      state.issue(),
      QUERY,
      OPTIONS,
    )).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_HIT' }))
  })

  it('fails closed when an eligible project index is missing or the fan-out cap is exceeded', async () => {
    const missing = setup({ missing: ['project-b'] })
    await expect(missing.service.searchAllProjects(
      missing.lease,
      missing.issue(),
      QUERY,
      OPTIONS,
    )).rejects.toThrowError(expect.objectContaining({ code: 'PROJECT_INDEX_UNAVAILABLE' }))

    const capped = setup({ maxProjects: 1 })
    await expect(capped.service.searchAllProjects(
      capped.lease,
      capped.issue(),
      QUERY,
      OPTIONS,
    )).rejects.toThrowError(expect.objectContaining({ code: 'PROJECT_LIMIT_EXCEEDED' }))
  })

  it('rejects foreign registry rows and stale/expired receipts without querying indexes', async () => {
    const foreign = project('project-x', 'X')
    foreign.operatorId = 'telegram:99'
    const foreignState = setup({ projects: [foreign] })
    await expect(foreignState.service.searchAllProjects(
      foreignState.lease,
      foreignState.issue(),
      QUERY,
      OPTIONS,
    )).rejects.toThrowError(expect.objectContaining({ code: 'BINDING_MISMATCH' }))
    expect(foreignState.calls).toEqual(['list:false'])

    const expired = setup()
    const receipt = expired.issue()
    expired.advance(30_000)
    await expect(expired.service.searchAllProjects(expired.lease, receipt, QUERY, OPTIONS))
      .rejects.toThrowError(expect.objectContaining({ code: 'EXPIRED' }))
    expect(expired.calls).toEqual([])
  })

  it('detects excerpt content mismatch after consuming the one-use capability', async () => {
    const state = setup({ readContent: { [hash('A1')]: 'changed' } })
    const [first] = await state.service.searchAllProjects(state.lease, state.issue(), QUERY, OPTIONS)

    await expect(state.service.openSearchHit(state.lease, first!.readCapability)).rejects
      .toThrow(CrossProjectSearchError)
    await expect(state.service.openSearchHit(state.lease, first!.readCapability)).rejects
      .toThrowError(expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }))
  })
})

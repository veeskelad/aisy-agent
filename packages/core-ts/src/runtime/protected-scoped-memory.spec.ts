import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { MemoryOp } from '../memory/index.js'
import { makeContextLeaseCoordinator } from './context-lease.js'
import type {
  RetrievalScope,
  ScopedRetrievalCandidate,
  SemanticRetrievalLeg,
} from './hybrid-retrieval.js'
import type {
  ProtectedMemoryFactRecordV2,
  ProtectedMemoryScope,
} from './protected-memory-publication.js'
import {
  ProtectedMemoryRecoveryGateError,
} from './protected-memory-recovery-gate.js'
import { ProtectedMemorySqliteStoreError } from './protected-memory-sqlite-store.js'
import {
  makeProtectedScopedMemoryRouter,
  ProtectedScopedMemoryError,
  type ProtectedScopedMemoryRuntime,
} from './protected-scoped-memory.js'
import type { ScopedMemoryEvent } from './scoped-memory.js'

const GLOBAL_SCOPE: ProtectedMemoryScope = { kind: 'global', scopeId: 'global' }
const PROJECT_SCOPE: ProtectedMemoryScope = {
  kind: 'project', scopeId: 'project:project-a', projectId: 'project-a',
}
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

function fact(
  scope: ProtectedMemoryScope,
  id: string,
  text = `${id} text`,
): ProtectedMemoryFactRecordV2 {
  return {
    schemaVersion: 2,
    operationId: sha256(`operation:${id}`),
    id,
    operatorId: 'telegram:42',
    profileId: 'default',
    scope: structuredClone(scope),
    text,
    factKey: sha256(id),
    keyTokens: [id],
    validAt: '2026-07-27T10:00:00.000Z',
    invalidAt: null,
    isHumanConfirmed: false,
    sourceAuthority: 50,
    confidence: 0.9,
    provenance: 'session:session-1:turn:1',
    sourcePath: `memory/facts/${sha256(id)}.md`,
    contentHash: sha256(text),
    published: true,
  }
}

function candidate(
  value: ProtectedMemoryFactRecordV2,
  score = 0.9,
  overrides: Partial<ScopedRetrievalCandidate> = {},
): ScopedRetrievalCandidate {
  return {
    hitId: value.id,
    scope: value.scope.kind,
    scopeId: value.scope.scopeId,
    ...(value.scope.kind === 'project' ? { projectId: value.scope.projectId } : {}),
    sourcePath: value.sourcePath,
    chunkId: value.id,
    contentHash: value.contentHash,
    provenance: value.provenance,
    score,
    ...overrides,
  }
}

function semanticLeg(input: {
  scope: ProtectedMemoryScope
  hits?: ScopedRetrievalCandidate[]
  availability?: 'healthy' | 'unavailable' | 'revoked'
  error?: Error
  search?: ReturnType<typeof vi.fn>
}): SemanticRetrievalLeg {
  const search = input.search ?? vi.fn(async () => {
    if (input.error) throw input.error
    return input.hits ?? []
  })
  return {
    availability: async (scope: RetrievalScope) => {
      expect(scope.scopeId).toBe(input.scope.scopeId)
      return input.availability ?? 'healthy'
    },
    search,
  }
}

function context(kind: 'workspace' | 'project' = 'project') {
  let id = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `operation-${++id}` })
  const lease = leases.acquire({
    operatorId: 'telegram:42',
    profileId: 'default',
    projectId: kind === 'project' ? 'project-a' : 'workspace-1',
    projectKind: kind,
    sessionId: 'session-1',
    root: kind === 'project' ? '/safe/project-a' : '/safe/workspace',
    generation: 1,
  })
  return { leases, lease }
}

function fakeRuntime(input: {
  scope: ProtectedMemoryScope
  rows?: Array<{ fact: ProtectedMemoryFactRecordV2; score: number }>
  recoveryError?: Error
  searchError?: Error
  installed?: boolean
  absent?: boolean
  target?: ProtectedMemoryFactRecordV2 | null
  invalidatedAt?: string | null
  deletionStatus?: 'DELETED' | 'NOT_FOUND'
}) {
  const assertScopeRecovered = vi.fn(async () => {
    if (input.recoveryError) throw input.recoveryError
  })
  const searchKeyword = vi.fn(async () => {
    if (input.searchError) throw input.searchError
    return input.rows ?? []
  })
  const loadTargetById = vi.fn(async (factId: string) => input.target === null
    ? null
    : {
      fact: input.target ?? fact(input.scope, factId),
      invalidatedAt: input.invalidatedAt ?? null,
    })
  const loadLiveFactById = vi.fn(async (factId: string) =>
    input.target === null || input.invalidatedAt != null
      ? null
      : input.target ?? fact(input.scope, factId))
  const verifyInstalled = vi.fn(async () => input.installed ?? true)
  const verifyAbsent = vi.fn(async () => input.absent ?? true)
  const publishFact = vi.fn(async (_lease, request) => fact(
    request.scope,
    request.factId,
    request.text,
  ))
  const updateFact = vi.fn(async (_lease, request) => ({
    status: 'SUPERSEDED' as const,
    fact: fact(request.scope, `replacement-${request.targetFactId}`, request.text),
  }))
  const deleteFact = vi.fn(async (_lease, request) => input.deletionStatus === 'NOT_FOUND'
    ? { status: 'NOT_FOUND' as const, factId: request.factId }
    : {
      status: 'DELETED' as const,
      factId: request.factId,
      operationId: `delete-${request.factId}`,
      humanConfirmed: request.humanConfirmed,
    })
  const runtime: ProtectedScopedMemoryRuntime = {
    scope: structuredClone(input.scope),
    recovery: { assertScopeRecovered },
    store: { loadTargetById, loadLiveFactById, searchKeyword },
    files: { verifyInstalled, verifyAbsent },
    publication: { publishFact },
    update: { updateFact },
    deletion: { deleteFact },
  }
  return {
    runtime,
    assertScopeRecovered,
    searchKeyword,
    loadTargetById,
    loadLiveFactById,
    verifyInstalled,
    verifyAbsent,
    publishFact,
    updateFact,
    deleteFact,
  }
}

function router(input: {
  leases: ReturnType<typeof makeContextLeaseCoordinator>
  global: ProtectedScopedMemoryRuntime | null
  project?: ProtectedScopedMemoryRuntime | null
  authorize?: boolean
  authorizeFn?: Parameters<typeof makeProtectedScopedMemoryRouter>[0]['authorizeHumanConfirmedDelete']
  events?: ScopedMemoryEvent[]
  semanticFor?: Parameters<typeof makeProtectedScopedMemoryRouter>[0]['semanticFor']
}) {
  let nextId = 0
  return makeProtectedScopedMemoryRouter({
    ...(input.semanticFor === undefined ? {} : { semanticFor: input.semanticFor }),
    leases: input.leases,
    globalRuntime: () => input.global,
    projectRuntime: (projectId) => projectId === 'project-a' ? input.project ?? null : null,
    newFactId: () => `new-${++nextId}`,
    provenanceFor: ({ lease, op, scope }) =>
      `${lease.sessionId}:${scope.scopeId}:${op.op}`,
    authorizeHumanConfirmedDelete: input.authorizeFn ?? (async () => input.authorize ?? false),
    emit: (event) => input.events?.push(event),
  })
}

describe('ProtectedScopedMemoryRouter', () => {
  it('reads only verified global memory from a Workspace lease', async () => {
    const ctx = context('workspace')
    const global = fakeRuntime({
      scope: GLOBAL_SCOPE,
      rows: [{ fact: fact(GLOBAL_SCOPE, 'global'), score: -1 }],
    })
    const memory = router({ leases: ctx.leases, global: global.runtime })

    await expect(memory.searchAutomatic(ctx.lease, 'query')).resolves.toMatchObject({
      requestedMode: 'hybrid',
      effectiveMode: 'keyword',
      status: 'SEMANTIC_UNAVAILABLE',
      hits: [expect.objectContaining({ id: 'global', scope: 'global' })],
    })
    expect(global.assertScopeRecovered).toHaveBeenCalledWith(ctx.lease, GLOBAL_SCOPE)
    // Keyword admission and post-fusion materialization verify independently.
    expect(global.verifyInstalled).toHaveBeenCalledTimes(2)
  })

  it('merges global and the exact leased Project deterministically', async () => {
    const ctx = context()
    const global = fakeRuntime({
      scope: GLOBAL_SCOPE,
      rows: [{ fact: fact(GLOBAL_SCOPE, 'global'), score: -1 }],
    })
    const project = fakeRuntime({
      scope: PROJECT_SCOPE,
      rows: [{ fact: fact(PROJECT_SCOPE, 'project'), score: -1 }],
    })
    const memory = router({ leases: ctx.leases, global: global.runtime, project: project.runtime })

    const result = await memory.searchAutomatic(ctx.lease, 'query')

    expect(result).toMatchObject({
      requestedMode: 'hybrid',
      effectiveMode: 'keyword',
      status: 'SEMANTIC_UNAVAILABLE',
    })
    expect(result.hits).toEqual([
      expect.objectContaining({
        id: 'global',
        scope: 'global',
        scopeId: 'global',
        sourcePath: `memory/facts/${sha256('global')}.md`,
        provenanceRef: 'session:session-1:turn:1',
      }),
      expect.objectContaining({
        id: 'project',
        scope: 'project',
        scopeId: 'project:project-a',
        projectId: 'project-a',
        sourcePath: `memory/facts/${sha256('project')}.md`,
        provenanceRef: 'session:session-1:turn:1',
      }),
    ])
    expect(project.searchKeyword).toHaveBeenCalledWith('query', 20)
  })

  it('visibly degrades to global when the exact Project runtime or keyword index is unavailable', async () => {
    const ctx = context()
    const events: ScopedMemoryEvent[] = []
    const global = fakeRuntime({
      scope: GLOBAL_SCOPE,
      rows: [{ fact: fact(GLOBAL_SCOPE, 'global'), score: -1 }],
    })
    const unavailable = router({ leases: ctx.leases, global: global.runtime, events })
    await expect(unavailable.searchAutomatic(ctx.lease, 'query')).resolves.toMatchObject({
      hits: [expect.objectContaining({ id: 'global' })],
      degraded: 'PROJECT_MEMORY_UNAVAILABLE',
    })

    const corruptKeyword = fakeRuntime({
      scope: PROJECT_SCOPE,
      searchError: new ProtectedMemorySqliteStoreError('CORRUPT_KEYWORD_INDEX'),
    })
    const degraded = router({
      leases: ctx.leases,
      global: global.runtime,
      project: corruptKeyword.runtime,
      events,
    })
    await expect(degraded.searchAutomatic(ctx.lease, 'query')).resolves.toMatchObject({
      degraded: 'PROJECT_MEMORY_UNAVAILABLE',
    })
    expect(events.filter(event => event.kind === 'memory.scope_degraded')).toHaveLength(2)
  })

  it.each([
    ['recovery conflict', new ProtectedMemoryRecoveryGateError('RECOVERY_CONFLICT')],
    ['recovery required', new ProtectedMemoryRecoveryGateError('RECOVERY_REQUIRED')],
    ['ledger corruption', new ProtectedMemorySqliteStoreError('CORRUPT_LEDGER')],
    ['an unknown implementation failure', new Error('unexpected defect')],
  ])('never degrades past %s', async (_label, error) => {
    const ctx = context()
    const events: ScopedMemoryEvent[] = []
    const global = fakeRuntime({ scope: GLOBAL_SCOPE })
    const project = error instanceof ProtectedMemoryRecoveryGateError
      ? fakeRuntime({ scope: PROJECT_SCOPE, recoveryError: error })
      : fakeRuntime({ scope: PROJECT_SCOPE, searchError: error })
    const memory = router({
      leases: ctx.leases,
      global: global.runtime,
      project: project.runtime,
      events,
    })

    await expect(memory.searchAutomatic(ctx.lease, 'query')).rejects.toBe(error)
    expect(events.filter(event => event.kind === 'memory.scope_degraded')).toEqual([])
  })

  it('fails closed when a canonical fact file or runtime scope cannot be verified', async () => {
    const ctx = context()
    const global = fakeRuntime({ scope: GLOBAL_SCOPE })
    const unverified = fakeRuntime({
      scope: PROJECT_SCOPE,
      rows: [{ fact: fact(PROJECT_SCOPE, 'project'), score: -1 }],
      installed: false,
    })
    const memory = router({ leases: ctx.leases, global: global.runtime, project: unverified.runtime })
    await expect(memory.searchAutomatic(ctx.lease, 'query')).rejects.toThrowError(
      expect.objectContaining({ code: 'READ_VERIFICATION_FAILED' }),
    )

    const foreign = fakeRuntime({
      scope: { kind: 'project', scopeId: 'project:project-b', projectId: 'project-b' },
    })
    const mismatched = router({ leases: ctx.leases, global: global.runtime, project: foreign.runtime })
    await expect(mismatched.searchAutomatic(ctx.lease, 'query')).rejects.toThrowError(
      expect.objectContaining({ code: 'READ_VERIFICATION_FAILED' }),
    )
  })

  it('maps protected ADD, UPDATE, DELETE and NOOP results through the exact scope', async () => {
    const ctx = context()
    const global = fakeRuntime({ scope: GLOBAL_SCOPE })
    const project = fakeRuntime({ scope: PROJECT_SCOPE })
    const memory = router({
      leases: ctx.leases,
      global: global.runtime,
      project: project.runtime,
    })

    await expect(memory.commitProject(
      ctx.lease,
      { op: 'ADD', text: 'new fact' },
      { withinSession: true },
    )).resolves.toEqual({ status: 'COMMITTED', factId: 'new-1' })
    await expect(memory.commitProject(
      ctx.lease,
      { op: 'UPDATE', targetId: 'old', text: 'updated fact' },
      { withinSession: true },
    )).resolves.toEqual({ status: 'SUPERSEDED', factId: 'replacement-old' })
    await expect(memory.commitProject(
      ctx.lease,
      { op: 'DELETE', targetId: 'old', humanConfirmed: false, reason: 'stale' },
      { withinSession: true },
    )).resolves.toEqual({ status: 'COMMITTED', factId: 'old' })
    const noop: MemoryOp = { op: 'NOOP', targetId: 'old' }
    await expect(memory.commitProject(ctx.lease, noop, { withinSession: true })).resolves.toEqual({
      status: 'COMMITTED', factId: 'old',
    })
    expect(project.publishFact).toHaveBeenCalledWith(ctx.lease, expect.objectContaining({
      factId: 'new-1', scope: PROJECT_SCOPE, provenance: 'session-1:project:project-a:ADD',
    }))
    expect(project.updateFact).toHaveBeenCalledWith(ctx.lease, expect.objectContaining({
      targetFactId: 'old', scope: PROJECT_SCOPE,
      provenance: 'session-1:project:project-a:UPDATE',
    }))
    expect(project.deleteFact).toHaveBeenCalledWith(ctx.lease, expect.objectContaining({
      factId: 'old', humanConfirmed: false, scope: PROJECT_SCOPE,
    }))
  })

  it('requires code-owned authorization before every human-confirmed deletion', async () => {
    const ctx = context()
    const global = fakeRuntime({ scope: GLOBAL_SCOPE })
    const project = fakeRuntime({ scope: PROJECT_SCOPE })
    const denied = router({
      leases: ctx.leases,
      global: global.runtime,
      project: project.runtime,
      authorize: false,
    })

    await expect(denied.commitProject(
      ctx.lease,
      { op: 'DELETE', targetId: 'fact-a', humanConfirmed: true, reason: 'operator request' },
      { withinSession: true },
    )).rejects.toThrowError(expect.objectContaining({ code: 'HUMAN_CONFIRMATION_REQUIRED' }))
    await expect(denied.forgetProject(
      ctx.lease,
      'fact-a',
      'operator request',
      true,
    )).rejects.toThrowError(expect.objectContaining({ code: 'HUMAN_CONFIRMATION_REQUIRED' }))
    expect(project.deleteFact).not.toHaveBeenCalled()
  })

  it('binds authorization to the exact verified immutable deletion target', async () => {
    const ctx = context()
    const global = fakeRuntime({ scope: GLOBAL_SCOPE })
    const target = fact(PROJECT_SCOPE, 'fact-a', 'exact private fact')
    const project = fakeRuntime({ scope: PROJECT_SCOPE, target })
    const authorize = vi.fn(async () => true)
    const memory = router({
      leases: ctx.leases,
      global: global.runtime,
      project: project.runtime,
      authorizeFn: authorize,
    })

    await expect(memory.forgetProject(
      ctx.lease,
      'fact-a',
      'operator request',
      true,
    )).resolves.toBeUndefined()
    expect(project.verifyInstalled).toHaveBeenCalledWith({
      sourcePath: target.sourcePath,
      contentHash: target.contentHash,
      sizeBytes: Buffer.byteLength(target.text, 'utf8'),
    })
    expect(authorize).toHaveBeenCalledWith({
      lease: ctx.lease,
      factId: 'fact-a',
      targetOperationId: target.operationId,
      factKey: target.factKey,
      sourcePath: target.sourcePath,
      contentHash: target.contentHash,
      reason: 'operator request',
      scope: PROJECT_SCOPE,
    })
    expect(project.deleteFact).toHaveBeenCalledOnce()
  })

  it('verifies absence before authorizing permanence for an already tombstoned fact', async () => {
    const ctx = context()
    const global = fakeRuntime({ scope: GLOBAL_SCOPE })
    const project = fakeRuntime({
      scope: PROJECT_SCOPE,
      invalidatedAt: '2026-07-27T11:59:00.000Z',
      absent: true,
    })
    const authorize = vi.fn(async () => true)
    const memory = router({
      leases: ctx.leases, global: global.runtime, project: project.runtime,
      authorizeFn: authorize,
    })

    await expect(memory.forgetProject(
      ctx.lease, 'fact-a', 'operator request', true,
    )).resolves.toBeUndefined()
    expect(project.verifyAbsent).toHaveBeenCalledOnce()
    expect(project.verifyInstalled).not.toHaveBeenCalled()
    expect(authorize).toHaveBeenCalledOnce()
  })

  it('fails closed before approval if target metadata or canonical file state is unverified', async () => {
    const ctx = context()
    const global = fakeRuntime({ scope: GLOBAL_SCOPE })
    const authorize = vi.fn(async () => true)
    const unverifiedFile = fakeRuntime({ scope: PROJECT_SCOPE, installed: false })
    const fileRouter = router({
      leases: ctx.leases, global: global.runtime, project: unverifiedFile.runtime,
      authorizeFn: authorize,
    })
    await expect(fileRouter.forgetProject(
      ctx.lease, 'fact-a', 'operator request', true,
    )).rejects.toThrowError(expect.objectContaining({ code: 'READ_VERIFICATION_FAILED' }))

    const malformed = fact(PROJECT_SCOPE, 'fact-a')
    malformed.contentHash = 'tampered'
    const malformedRuntime = fakeRuntime({ scope: PROJECT_SCOPE, target: malformed })
    const malformedRouter = router({
      leases: ctx.leases, global: global.runtime, project: malformedRuntime.runtime,
      authorizeFn: authorize,
    })
    await expect(malformedRouter.forgetProject(
      ctx.lease, 'fact-a', 'operator request', true,
    )).rejects.toThrowError(expect.objectContaining({ code: 'READ_VERIFICATION_FAILED' }))
    expect(authorize).not.toHaveBeenCalled()
    expect(unverifiedFile.deleteFact).not.toHaveBeenCalled()
    expect(malformedRuntime.deleteFact).not.toHaveBeenCalled()
  })

  it('keeps forget idempotent without prompting when the fact is already absent', async () => {
    const ctx = context()
    const global = fakeRuntime({ scope: GLOBAL_SCOPE })
    const project = fakeRuntime({
      scope: PROJECT_SCOPE,
      target: null,
      deletionStatus: 'NOT_FOUND',
    })
    const authorize = vi.fn(async () => true)
    const memory = router({
      leases: ctx.leases,
      global: global.runtime,
      project: project.runtime,
      authorizeFn: authorize,
    })

    await expect(memory.forgetProject(
      ctx.lease,
      'already-absent',
      'operator request',
      true,
    )).resolves.toBeUndefined()
    expect(authorize).not.toHaveBeenCalled()
    expect(project.deleteFact).toHaveBeenCalledOnce()
  })

  it('rejects project writes from a Workspace lease without resolving a Project runtime', async () => {
    const ctx = context('workspace')
    const global = fakeRuntime({ scope: GLOBAL_SCOPE })
    const memory = router({ leases: ctx.leases, global: global.runtime })

    await expect(memory.commitProject(
      ctx.lease,
      { op: 'ADD', text: 'wrong scope' },
      { withinSession: true },
    )).rejects.toBeInstanceOf(ProtectedScopedMemoryError)
  })

  it('rejects a closed lease before recovery or storage I/O', async () => {
    const ctx = context()
    const global = fakeRuntime({ scope: GLOBAL_SCOPE })
    const project = fakeRuntime({ scope: PROJECT_SCOPE })
    const memory = router({
      leases: ctx.leases,
      global: global.runtime,
      project: project.runtime,
    })
    await ctx.leases.quiesceAndClose(ctx.lease)

    await expect(memory.searchAutomatic(ctx.lease, 'query')).rejects.toThrowError(
      expect.objectContaining({ code: 'STALE_CONTEXT' }),
    )
    expect(global.assertScopeRecovered).not.toHaveBeenCalled()
    expect(project.assertScopeRecovered).not.toHaveBeenCalled()
  })
})

describe('ProtectedScopedMemoryRouter — retrieval modes (ADR-0065)', () => {
  const workspaceHit = () => fakeRuntime({
    scope: GLOBAL_SCOPE,
    rows: [{ fact: fact(GLOBAL_SCOPE, 'global'), score: -1 }],
  })

  it('keyword mode never consults the semantic leg', async () => {
    const ctx = context('workspace')
    const availability = vi.fn(async () => 'healthy' as const)
    const search = vi.fn(async () => [])
    const scoped = router({
      leases: ctx.leases,
      global: workspaceHit().runtime,
      semanticFor: () => ({ availability, search }),
    })

    const result = await scoped.searchAutomatic(ctx.lease, 'query', { mode: 'keyword' })
    expect(availability).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      requestedMode: 'keyword', effectiveMode: 'keyword', status: 'OK',
      hits: [expect.objectContaining({ componentRanks: { keyword: 1 } })],
    })
  })

  it('semantic mode can return a verified fact absent from keyword top 20', async () => {
    const ctx = context('workspace')
    const semanticFact = fact(GLOBAL_SCOPE, 'semantic-only')
    const global = fakeRuntime({ scope: GLOBAL_SCOPE, rows: [] })
    const scoped = router({
      leases: ctx.leases,
      global: global.runtime,
      semanticFor: () => semanticLeg({
        scope: GLOBAL_SCOPE,
        hits: [candidate(semanticFact)],
      }),
    })

    const result = await scoped.searchAutomatic(ctx.lease, 'lexically disjoint', { mode: 'semantic' })
    expect(result).toMatchObject({
      requestedMode: 'semantic', effectiveMode: 'semantic', status: 'OK',
      hits: [expect.objectContaining({
        id: 'semantic-only', componentRanks: { semantic: 1 }, chunkId: 'semantic-only',
      })],
    })
    expect(global.searchKeyword).not.toHaveBeenCalled()
  })

  it('uses independent capped legs and normative RRF instead of membership sorting', async () => {
    const ctx = context('workspace')
    const a = fact(GLOBAL_SCOPE, 'a')
    const b = fact(GLOBAL_SCOPE, 'b')
    const c = fact(GLOBAL_SCOPE, 'c')
    const global = fakeRuntime({
      scope: GLOBAL_SCOPE,
      rows: [{ fact: a, score: -2 }, { fact: b, score: -1 }],
    })
    const search = vi.fn(async () => [candidate(b, 0.9), candidate(c, 0.8)])
    const scoped = router({
      leases: ctx.leases,
      global: global.runtime,
      semanticFor: () => semanticLeg({ scope: GLOBAL_SCOPE, search }),
    })

    const result = await scoped.searchAutomatic(ctx.lease, 'query', { mode: 'hybrid', limit: 3 })
    expect(result).toMatchObject({ requestedMode: 'hybrid', effectiveMode: 'hybrid', status: 'OK' })
    expect(result.hits.map(hit => hit.id)).toEqual(['b', 'a', 'c'])
    expect(result.hits[0]?.componentRanks).toEqual({ keyword: 2, semantic: 1 })
    expect(global.searchKeyword).toHaveBeenCalledWith('query', 20)
    expect(search).toHaveBeenCalledWith(GLOBAL_SCOPE, 'query', { limit: 20 })
  })

  it('reports missing/failed semantic visibly and never returns keyword hits as semantic', async () => {
    const failingCtx = context('workspace')
    const events: ScopedMemoryEvent[] = []
    const failing = router({
      leases: failingCtx.leases,
      global: workspaceHit().runtime,
      semanticFor: () => semanticLeg({ scope: GLOBAL_SCOPE, error: new Error('provider down') }),
      events,
    })
    const failed = await failing.searchAutomatic(failingCtx.lease, 'query', { mode: 'hybrid' })
    expect(failed).toMatchObject({
      requestedMode: 'hybrid', effectiveMode: 'keyword', status: 'SEMANTIC_UNAVAILABLE',
      semanticDegraded: 'SEMANTIC_UNAVAILABLE',
      hits: [expect.objectContaining({ id: 'global' })],
    })
    expect(events).toEqual([expect.objectContaining({
      kind: 'memory.semantic_degraded', scopeId: 'global', status: 'SEMANTIC_UNAVAILABLE',
    })])

    const plainCtx = context('workspace')
    const keywordOnly = router({
      leases: plainCtx.leases,
      global: fakeRuntime({
        scope: GLOBAL_SCOPE,
        rows: [{ fact: fact(GLOBAL_SCOPE, 'global'), score: -1 }],
      }).runtime,
    })
    await expect(keywordOnly.searchAutomatic(plainCtx.lease, 'query', { mode: 'semantic' }))
      .resolves.toMatchObject({
        requestedMode: 'semantic', effectiveMode: 'none', status: 'SEMANTIC_UNAVAILABLE',
        hits: [], semanticDegraded: 'SEMANTIC_UNAVAILABLE',
      })
  })

  it('keeps a sensitive query local and exposes the exact local-only status', async () => {
    const ctx = context('workspace')
    const events: ScopedMemoryEvent[] = []
    const availability = vi.fn(async () => 'healthy' as const)
    const search = vi.fn(async () => [])
    const scoped = router({
      leases: ctx.leases,
      global: workspaceHit().runtime,
      semanticFor: () => ({ availability, search }),
      events,
    })

    const result = await scoped.searchAutomatic(ctx.lease, 'api_key=secret-value', {
      mode: 'hybrid',
    })
    expect(result).toMatchObject({
      requestedMode: 'hybrid', effectiveMode: 'keyword',
      status: 'SENSITIVE_INPUT_LOCAL_ONLY',
    })
    expect(result).not.toHaveProperty('semanticDegraded')
    expect(availability).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({
      kind: 'memory.embedding_input_blocked', status: 'SENSITIVE_INPUT_LOCAL_ONLY',
    })])
  })

  it('rejects stale, tombstoned and metadata-conflicting semantic candidates', async () => {
    const staleCtx = context('workspace')
    const staleFact = fact(GLOBAL_SCOPE, 'stale')
    const staleRuntime = fakeRuntime({
      scope: GLOBAL_SCOPE,
      rows: [],
      invalidatedAt: '2026-07-29T12:00:00.000Z',
    })
    const stale = router({
      leases: staleCtx.leases,
      global: staleRuntime.runtime,
      semanticFor: () => semanticLeg({ scope: GLOBAL_SCOPE, hits: [candidate(staleFact)] }),
    })
    await expect(stale.searchAutomatic(staleCtx.lease, 'query', { mode: 'semantic' }))
      .rejects.toThrow(expect.objectContaining({ code: 'DERIVED_FILTER_VIOLATION' }))

    const conflictCtx = context('workspace')
    const conflictFact = fact(GLOBAL_SCOPE, 'conflict')
    const conflictRuntime = fakeRuntime({ scope: GLOBAL_SCOPE, rows: [] })
    const conflict = router({
      leases: conflictCtx.leases,
      global: conflictRuntime.runtime,
      semanticFor: () => semanticLeg({
        scope: GLOBAL_SCOPE,
        hits: [candidate(conflictFact, 0.9, { sourcePath: 'memory/facts/foreign.md' })],
      }),
    })
    await expect(conflict.searchAutomatic(conflictCtx.lease, 'query', { mode: 'semantic' }))
      .rejects.toThrow(expect.objectContaining({ code: 'CONFLICTING_HIT' }))

    const foreignCtx = context('workspace')
    const foreignRuntime = fakeRuntime({ scope: GLOBAL_SCOPE, rows: [] })
    const foreign = router({
      leases: foreignCtx.leases,
      global: foreignRuntime.runtime,
      semanticFor: () => semanticLeg({
        scope: GLOBAL_SCOPE,
        hits: [candidate(fact(PROJECT_SCOPE, 'foreign'))],
      }),
    })
    await expect(foreign.searchAutomatic(foreignCtx.lease, 'query', { mode: 'semantic' }))
      .rejects.toThrow(expect.objectContaining({ code: 'CROSS_SCOPE_HIT' }))
  })

  it('keeps healthy semantic scope hits when another scope is unavailable', async () => {
    const ctx = context()
    const globalFact = fact(GLOBAL_SCOPE, 'global-semantic')
    const global = fakeRuntime({ scope: GLOBAL_SCOPE, rows: [] })
    const project = fakeRuntime({ scope: PROJECT_SCOPE, rows: [] })
    const scoped = router({
      leases: ctx.leases,
      global: global.runtime,
      project: project.runtime,
      semanticFor: (_runtime, scope) => scope.kind === 'global'
        ? semanticLeg({ scope, hits: [candidate(globalFact)] })
        : semanticLeg({ scope, availability: 'unavailable' }),
    })

    await expect(scoped.searchAutomatic(ctx.lease, 'query', { mode: 'semantic' }))
      .resolves.toMatchObject({
        requestedMode: 'semantic', effectiveMode: 'semantic',
        status: 'SEMANTIC_UNAVAILABLE', semanticDegraded: 'SEMANTIC_UNAVAILABLE',
        hits: [expect.objectContaining({ id: 'global-semantic' })],
      })
    await expect(scoped.searchAutomatic(ctx.lease, 'query', { mode: 'hybrid' }))
      .resolves.toMatchObject({
        requestedMode: 'hybrid', effectiveMode: 'hybrid',
        status: 'SEMANTIC_UNAVAILABLE', semanticDegraded: 'SEMANTIC_UNAVAILABLE',
        hits: [expect.objectContaining({ id: 'global-semantic' })],
      })
  })
})

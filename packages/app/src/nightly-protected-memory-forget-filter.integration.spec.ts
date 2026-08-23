import {
  makeContextLeaseCoordinator,
  type NormalizedDayLog,
  type ProtectedMemoryScope,
  type TurnContextLease,
} from '@aisy/core'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeNightlyProtectedMemoryForgetFilter,
  type NightlyProtectedMemoryScopeRuntime,
  NightlyProtectedMemoryForgetFilterError,
} from './nightly-protected-memory-forget-filter.js'
import {
  makeNodeProtectedMemoryScopeRuntime,
  type NodeProtectedMemoryScopeRuntime,
} from './protected-memory-runtime.js'

const roots: string[] = []

function textLog(...content: string[]): NormalizedDayLog {
  return {
    date: '2026-07-28',
    records: content.map((text, index) => ({
      kind: 'utterance',
      ts: `2026-07-28T01:00:0${index}.000Z`,
      payload: { role: 'user', provenance: 'operator', content: text },
    })),
  }
}

function previewRuntime(input: {
  root: string
  name: string
  scope: ProtectedMemoryScope
  leases: ReturnType<typeof makeContextLeaseCoordinator>
}): Extract<NodeProtectedMemoryScopeRuntime, { mode: 'preview' }> {
  const contentRoot = join(input.root, input.name, 'content')
  mkdirSync(contentRoot, { recursive: true, mode: 0o700 })
  const runtime = makeNodeProtectedMemoryScopeRuntime({
    mode: 'preview',
    paths: {
      ledger: join(input.root, input.name, 'ledger.sqlite'),
      keyword: join(input.root, input.name, 'keyword.sqlite'),
      semantic: join(input.root, input.name, 'semantic.sqlite'),
      barrier: join(input.root, input.name, 'barrier.sqlite'),
      contentRoot,
      stagingRoot: join(input.root, input.name, 'staging'),
    },
    operatorId: 'telegram:42',
    profileId: 'default',
    scope: input.scope,
    leases: input.leases,
    descriptor: {
      provider: 'openrouter',
      modelId: 'test-2d',
      modelRevision: '1',
      dimensions: 2,
      normalizationVersion: 'nfkc-v1',
      chunkerVersion: 'fact-v1',
    },
    nowIso: () => '2026-07-28T00:00:00.000Z',
    newFactId: () => 'unused-update-id',
    deliverPublicationAuditOnce: async () => undefined,
    deliverDeletionAuditOnce: async () => undefined,
    deliverUpdateAuditOnce: async () => undefined,
  })
  if (runtime.mode !== 'preview') throw new Error('preview runtime unavailable')
  return runtime
}

async function forget(
  runtime: Extract<NodeProtectedMemoryScopeRuntime, { mode: 'preview' }>,
  lease: TurnContextLease,
  factId: string,
  text: string,
): Promise<void> {
  await runtime.publication.publishFact(lease, {
    factId,
    text,
    provenance: `session:${lease.sessionId}`,
    scope: runtime.scope,
  })
  await runtime.deletion.deleteFact(lease, {
    factId,
    reason: 'operator-confirmed forget',
    humanConfirmed: true,
    scope: runtime.scope,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('nightly protected-memory forget filter', () => {
  it('filters global/project exact and residual matches and repeats identically after restart', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-nightly-forget-')))
    roots.push(root)
    let id = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `forget-${++id}` })
    const lease = leases.acquire({
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'project-a',
      projectKind: 'project',
      sessionId: 'nightly-project-a',
      root: join(root, 'project-a'),
      generation: 7,
    })
    const globalScope: ProtectedMemoryScope = { kind: 'global', scopeId: 'global' }
    const projectScope: ProtectedMemoryScope = {
      kind: 'project', scopeId: 'project:project-a', projectId: 'project-a',
    }
    let global = previewRuntime({ root, name: 'global', scope: globalScope, leases })
    let project = previewRuntime({ root, name: 'project-a', scope: projectScope, leases })
    await forget(global, lease, 'global-home', 'My home is Berlin')
    await forget(project, lease, 'project-secret', 'Project Phoenix launch code')
    const events: unknown[] = []
    const filter = () => makeNightlyProtectedMemoryForgetFilter({
      leases,
      globalRuntime: () => global,
      projectRuntime: () => project,
      emit: event => events.push(event),
    })
    const binding = {
      operatorId: lease.operatorId,
      profileId: lease.profileId,
      projectId: lease.projectId,
      sessionId: lease.sessionId,
      scope: 'project' as const,
    }
    const rawDayLog = textLog(
      'Berlin residence',
      'Project Phoenix launch code',
      'Berlin weather tomorrow',
      'Weather in Moscow tomorrow',
    )

    const first = await filter()({ binding, lease, rawDayLog })
    expect(first.records.map(record => (record.payload as { content: string }).content))
      .toEqual(['Weather in Moscow tomorrow'])
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'night.forget_filter.completed',
      projectId: 'project-a',
      sessionId: 'nightly-project-a',
      droppedExact: 2,
      droppedReview: 1,
      kept: 1,
    }))
    expect(JSON.stringify(events)).not.toContain('Berlin')
    expect(JSON.stringify(events)).not.toContain('Phoenix')
    expect(JSON.stringify(events)).not.toContain(root)

    global.close()
    project.close()
    global = previewRuntime({ root, name: 'global', scope: globalScope, leases })
    project = previewRuntime({ root, name: 'project-a', scope: projectScope, leases })
    await expect(filter()({ binding, lease, rawDayLog })).resolves.toEqual(first)
    global.close()
    project.close()
    await leases.quiesceAndClose(lease)
  })

  it('rejects a stale lease before resolving either protected-memory runtime', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-nightly-forget-stale-')))
    roots.push(root)
    let id = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `stale-${++id}` })
    const lease = leases.acquire({
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      projectKind: 'project', sessionId: 'nightly-project-a',
      root: join(root, 'project-a'), generation: 1,
    })
    await leases.quiesceAndClose(lease)
    let runtimeCalls = 0
    const filter = makeNightlyProtectedMemoryForgetFilter({
      leases,
      globalRuntime: () => { runtimeCalls += 1; return null },
      projectRuntime: () => { runtimeCalls += 1; return null },
    })

    await expect(filter({
      binding: {
        operatorId: lease.operatorId, profileId: lease.profileId,
        projectId: lease.projectId, sessionId: lease.sessionId, scope: 'project',
      },
      lease,
      rawDayLog: textLog('clean'),
    })).rejects.toBeInstanceOf(NightlyProtectedMemoryForgetFilterError)
    expect(runtimeCalls).toBe(0)
  })

  it('redacts recovery failure and rejects unsupported structured activity fail-closed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-nightly-forget-fail-')))
    roots.push(root)
    let id = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `fail-${++id}` })
    const lease = leases.acquire({
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      projectKind: 'project', sessionId: 'nightly-project-a',
      root: join(root, 'project-a'), generation: 1,
    })
    const binding = {
      operatorId: lease.operatorId, profileId: lease.profileId,
      projectId: lease.projectId, sessionId: lease.sessionId, scope: 'project' as const,
    }
    const events: unknown[] = []
    const projectRuntime: NightlyProtectedMemoryScopeRuntime = {
      scope: { kind: 'project', scopeId: 'project:project-a', projectId: 'project-a' },
      recovery: { assertScopeRecovered: async () => undefined },
      store: { classifyForgetCandidates: () => 'PASS' },
      withScopeExclusive: async (_lease, run) => run(),
    }
    const failedGlobal: NightlyProtectedMemoryScopeRuntime = {
      scope: { kind: 'global', scopeId: 'global' },
      recovery: {
        assertScopeRecovered: async () => {
          throw new Error(`RECOVERY_REQUIRED:${root}/private-ledger.sqlite`)
        },
      },
      store: { classifyForgetCandidates: () => 'PASS' },
      withScopeExclusive: async (_lease, run) => run(),
    }
    const failed = makeNightlyProtectedMemoryForgetFilter({
      leases,
      globalRuntime: () => failedGlobal,
      projectRuntime: () => projectRuntime,
      emit: event => events.push(event),
    })
    await expect(failed({ binding, lease, rawDayLog: textLog('clean') })).rejects.toEqual(
      expect.objectContaining({
        code: 'NIGHTLY_FORGET_FILTER_UNAVAILABLE',
        message: 'NIGHTLY_FORGET_FILTER_UNAVAILABLE',
      }),
    )
    expect(JSON.stringify(events)).not.toContain(root)
    expect(JSON.stringify(events)).not.toContain('RECOVERY_REQUIRED')

    const globalRuntime: NightlyProtectedMemoryScopeRuntime = {
      ...failedGlobal,
      recovery: { assertScopeRecovered: async () => undefined },
    }
    const strict = makeNightlyProtectedMemoryForgetFilter({
      leases,
      globalRuntime: () => globalRuntime,
      projectRuntime: () => projectRuntime,
    })
    await expect(strict({
      binding,
      lease,
      rawDayLog: {
        date: '2026-07-28',
        records: [{
          kind: 'tool-call',
          ts: '2026-07-28T01:00:00.000Z',
          payload: { tool: 'read_file', arguments: { path: '/private' } },
        }],
      },
    })).rejects.toBeInstanceOf(NightlyProtectedMemoryForgetFilterError)
    await leases.quiesceAndClose(lease)
  })
})

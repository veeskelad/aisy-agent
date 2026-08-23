import {
  deriveDeterministicMemoryFactKey,
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  makeProjectService,
  makeSessionTranscript,
  makeSwitchAuthority,
  type FrozenSnapshot,
  type ProjectRegistryStateV2,
  type ResolvedWorkBinding,
  type TranscriptBinding,
} from '@aisy/core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeNightlyMaintenanceBindingStore } from './nightly-maintenance-binding-store.js'
import {
  makeNightlyProjectMaintenanceCoordinator,
  NightlyProjectMaintenanceError,
} from './nightly-project-maintenance.js'
import {
  makeNodeProtectedMemoryNightlyProjectMaintenanceCoordinator,
  type NightlyProtectedMemoryScopeRuntime,
} from './nightly-protected-memory-forget-filter.js'
import { makeNodeSessionTranscriptPersistence } from './session-transcript-store.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}
const frozen: FrozenSnapshot = {
  prefixBytes: new TextEncoder().encode('prefix'),
  prefixHash: 'caller-value',
  breakpoints: [],
  takenAt: '2026-07-28T00:00:00.000Z',
}
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-nightly-project-maintenance-'))
  roots.push(value)
  return value
}

function fixture() {
  let id = 0
  let durable: ProjectRegistryStateV2 = makeFreshProjectRegistryV2({
    ...OWNER,
    workspaceRoot: '/Users/operator/workspace',
    nowIso: () => '2026-07-28T00:00:00.000Z',
    newId: () => `registry-${++id}`,
    policy: POLICY,
  })
  const makeRegistry = () => makeProjectRegistryV2({
    state: durable,
    policy: POLICY,
    nowIso: () => '2026-07-28T00:00:00.000Z',
    newId: () => `registry-${++id}`,
    persistence: { saveAtomic: (state) => { durable = state } },
  })
  const registry = makeRegistry()
  const workspace = registry.listContexts(OWNER).find((item) => item.kind === 'workspace')!
  const projectASelection = registry.createProject({
    ...OWNER,
    name: 'Project A',
    slug: 'project-a',
    root: '/Users/operator/projects/project-a',
    origin: 'created',
  })
  const projectBSelection = registry.createProject({
    ...OWNER,
    name: 'Project B',
    slug: 'project-b',
    root: '/Users/operator/projects/project-b',
    origin: 'created',
  })
  const workspaceSession = registry.createSession({ ...OWNER, projectId: workspace.id, name: 'Nightly workspace' })
  const projectASession = registry.createSession({
    ...OWNER,
    projectId: projectASelection.projectId,
    name: 'Nightly A',
  })
  const projectBSession = registry.createSession({
    ...OWNER,
    projectId: projectBSelection.projectId,
    name: 'Nightly B',
  })
  registry.switchContext({
    ...OWNER,
    projectId: workspace.id,
    sessionId: workspaceSession.id,
    expectedGeneration: registry.getActive(OWNER).generation,
  })
  const bindings = {
    workspace: {
      ...OWNER,
      projectId: workspace.id,
      sessionId: workspaceSession.id,
      scope: 'workspace' as const,
    },
    projects: [
      {
        ...OWNER,
        projectId: projectASelection.projectId,
        sessionId: projectASession.id,
        scope: 'project' as const,
      },
      {
        ...OWNER,
        projectId: projectBSelection.projectId,
        sessionId: projectBSession.id,
        scope: 'project' as const,
      },
    ],
  }
  let leaseId = 0
  const makeRuntime = (current = makeRegistry()) => {
    const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
    const authority = makeSwitchAuthority({
      secret: Buffer.alloc(32, 1),
      nowMs: () => Date.parse('2026-07-28T00:00:00.000Z'),
      newId: () => `receipt-${++leaseId}`,
      nonces: {
        issue: () => {},
        has: () => false,
        consume: () => false,
      },
    })
    return {
      leases,
      registry: current,
      service: makeProjectService({ registry: current, leases, authority }),
    }
  }
  return { bindings, durable: () => durable, makeRegistry, makeRuntime, registry }
}

async function seed(
  transcriptRoot: string,
  binding: ResolvedWorkBinding,
  rows: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>,
): Promise<void> {
  const transcript = makeSessionTranscript({
    persistence: makeNodeSessionTranscriptPersistence({ root: transcriptRoot }),
    classifyLoadBearing: () => ({ loadBearing: false, classifierVersion: 'rules-v1' }),
  })
  const exact: TranscriptBinding = {
    operatorId: binding.operatorId,
    profileId: binding.profileId,
    projectId: binding.projectId,
    sessionId: binding.sessionId,
  }
  await transcript.createExactSession(exact, frozen, '2026-07-28T00:00:00.000Z')
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    await transcript.append({
      ...exact,
      eventId: `${binding.sessionId}-event-${index + 1}`,
      role: row.role,
      provenance: row.role === 'user' || row.role === 'system' ? 'operator' : 'untrusted',
      content: row.content,
      ts: `2026-07-28T0${index + 1}:00:00.000Z`,
    })
  }
}

describe('nightly Project maintenance composition', () => {
  it('captures separate forget-filtered Project logs and reproduces them after restart', async () => {
    const stateRoot = root()
    const transcriptRoot = join(stateRoot, 'transcripts')
    const bindingPath = join(stateRoot, 'nightly-maintenance-bindings.json')
    const state = fixture()
    await seed(transcriptRoot, state.bindings.projects[0]!, [
      { role: 'user', content: 'project-a-keep' },
      { role: 'assistant', content: 'project-a-forget' },
      { role: 'system', content: 'project-a-DNA-must-not-enter-memory' },
    ])
    await seed(transcriptRoot, state.bindings.projects[1]!, [
      { role: 'user', content: 'project-b-keep' },
    ])
    const bindingStore = makeNodeNightlyMaintenanceBindingStore({ path: bindingPath })
    bindingStore.save(state.bindings)

    const captureWith = async (runtime: ReturnType<typeof state.makeRuntime>) => {
      const loaded = makeNodeNightlyMaintenanceBindingStore({ path: bindingPath }).load()
      if (loaded.status !== 'ready') throw new Error('expected ready bindings')
      const workspaceLease = runtime.service.acquireBoundContext(loaded.bindings.workspace)
      const forgottenFactKey = deriveDeterministicMemoryFactKey('project-a-forget').factKey
      const globalMemory: NightlyProtectedMemoryScopeRuntime = {
        scope: { kind: 'global', scopeId: 'global' },
        recovery: { assertScopeRecovered: async () => undefined },
        store: { classifyForgetCandidates: () => 'PASS' },
        withScopeExclusive: async (_lease, run) => run(),
      }
      const coordinator = makeNodeProtectedMemoryNightlyProjectMaintenanceCoordinator({
        bindings: loaded.bindings,
        service: runtime.service,
        leases: runtime.leases,
        transcriptRoot,
        globalRuntime: () => globalMemory,
        projectRuntime: projectId => ({
          scope: { kind: 'project', scopeId: `project:${projectId}`, projectId },
          recovery: { assertScopeRecovered: async () => undefined },
          store: {
            classifyForgetCandidates: candidates => projectId === loaded.bindings.projects[0]!.projectId &&
              candidates.some(candidate => candidate.factKey === forgottenFactKey)
              ? 'FORGOTTEN'
              : 'PASS',
          },
          withScopeExclusive: async (_lease, run) => run(),
        }),
      })
      const result = await coordinator.capture(workspaceLease, '2026-07-28')
      await runtime.service.releaseTurnContext(workspaceLease)
      return result
    }

    const first = await captureWith(state.makeRuntime(state.registry))
    const restarted = await captureWith(state.makeRuntime(state.makeRegistry()))
    expect(restarted).toEqual(first)
    expect(first).toHaveLength(2)
    expect(JSON.stringify(first[0])).toContain('project-a-keep')
    expect(JSON.stringify(first[0])).not.toContain('project-a-forget')
    expect(JSON.stringify(first[0])).not.toContain('project-a-DNA')
    expect(JSON.stringify(first[0])).not.toContain('project-b-keep')
    expect(JSON.stringify(first[1])).toContain('project-b-keep')
    expect(JSON.stringify(first[1])).not.toContain('project-a-keep')
  })

  it('rejects a filter that fabricates or rewrites records and releases the barrier', async () => {
    const transcriptRoot = join(root(), 'transcripts')
    const state = fixture()
    await seed(transcriptRoot, state.bindings.projects[0]!, [{ role: 'user', content: 'original' }])
    await seed(transcriptRoot, state.bindings.projects[1]!, [{ role: 'user', content: 'project-b' }])
    const runtime = state.makeRuntime(state.registry)
    const workspaceLease = runtime.service.acquireBoundContext(state.bindings.workspace)
    const coordinator = makeNightlyProjectMaintenanceCoordinator({
      bindings: state.bindings,
      service: runtime.service,
      leases: runtime.leases,
      transcriptRoot,
      forgetFilter: async ({ rawDayLog }) => ({
        ...rawDayLog,
        records: rawDayLog.records.map((record) => ({
          ...record,
          payload: { rewrittenPrivateDetail: true },
        })),
      }),
    })

    await expect(coordinator.capture(workspaceLease, '2026-07-28')).rejects.toEqual(
      expect.objectContaining<Partial<NightlyProjectMaintenanceError>>({
        code: 'NIGHTLY_PROJECT_MAINTENANCE_UNAVAILABLE',
        message: 'NIGHTLY_PROJECT_MAINTENANCE_UNAVAILABLE',
      }),
    )
    const projectLease = runtime.service.acquireBoundContext(state.bindings.projects[0]!)
    await runtime.service.releaseTurnContext(projectLease)
    await runtime.service.releaseTurnContext(workspaceLease)
  })

  it('rejects a stale Workspace authority before Project or filter I/O', async () => {
    const state = fixture()
    const runtime = state.makeRuntime(state.registry)
    const workspaceLease = runtime.service.acquireBoundContext(state.bindings.workspace)
    await runtime.service.releaseTurnContext(workspaceLease)
    let filterCalls = 0
    const coordinator = makeNightlyProjectMaintenanceCoordinator({
      bindings: state.bindings,
      service: runtime.service,
      leases: runtime.leases,
      transcriptRoot: join(root(), 'must-not-exist'),
      forgetFilter: async ({ rawDayLog }) => { filterCalls++; return rawDayLog },
    })

    await expect(coordinator.capture(workspaceLease, '2026-07-28')).rejects.toMatchObject({
      code: 'NIGHTLY_PROJECT_MAINTENANCE_UNAVAILABLE',
    })
    expect(filterCalls).toBe(0)
  })
})

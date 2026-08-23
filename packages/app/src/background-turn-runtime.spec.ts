import { describe, expect, it } from 'vitest'
import {
  makeContextLeaseCoordinator,
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  makeProjectService,
  makeSwitchAuthority,
  type ConfinementPort,
  type ProjectRegistryStateV2,
  type ResolvedWorkBinding,
  type ScopedMemoryRouter,
  type ToolCall,
  type ToolResult,
  type TurnContextLease,
} from '@aisy/core'
import {
  makeBackgroundTurnRuntimeFactory,
  makeInteractiveTurnRuntimeFactory,
} from './interactive-turn-runtime.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}
const SOURCE_HASH = 'b'.repeat(64)

describe('background turn runtime', () => {
  it('resolves the saved project/system-session after switch and restart, then stops on archive', async () => {
    let registryId = 0
    let durable: ProjectRegistryStateV2 = makeFreshProjectRegistryV2({
      ...OWNER,
      workspaceRoot: '/Users/operator/workspace',
      nowIso: () => '2026-07-27T00:00:00.000Z',
      newId: () => `registry-${++registryId}`,
      policy: POLICY,
    })
    const makeRegistry = () => makeProjectRegistryV2({
      state: durable,
      policy: POLICY,
      nowIso: () => '2026-07-27T00:00:00.000Z',
      newId: () => `registry-${++registryId}`,
      persistence: { saveAtomic: (state) => { durable = state } },
    })
    const firstRegistry = makeRegistry()
    const projectSelection = firstRegistry.createProject({
      ...OWNER,
      name: 'Project A',
      slug: 'project-a',
      root: '/Users/operator/projects/project-a',
      origin: 'created',
    })

    let leaseId = 0
    const makeRuntime = (registry: ReturnType<typeof makeRegistry>) => {
      const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
      const nonces = new Map<string, string>()
      const authority = makeSwitchAuthority({
        secret: Buffer.alloc(32, 7),
        nowMs: () => Date.parse('2026-07-27T00:00:00.000Z'),
        newId: () => `receipt-${leaseId}`,
        nonces: {
          issue: (item) => { nonces.set(item.receiptId, item.mac) },
          has: (id, mac) => nonces.get(id) === mac,
          consume: (id, mac) => {
            if (nonces.get(id) !== mac) return false
            nonces.delete(id)
            return true
          },
        },
      })
      return {
        authority,
        leases,
        service: makeProjectService({ registry, leases, authority }),
      }
    }
    const first = makeRuntime(firstRegistry)
    const built: Array<{
      lease: TurnContextLease
      grantBinding: ResolvedWorkBinding
      executeTool: (call: ToolCall) => Promise<ToolResult>
    }> = []
    const memoryCalls: TurnContextLease[] = []
    const scopedMemory: ScopedMemoryRouter = {
      searchAutomatic: async (lease) => {
        memoryCalls.push(lease)
        return {
          requestedMode: 'keyword', effectiveMode: 'keyword', status: 'OK', hits: [],
        }
      },
      commitGlobal: async () => ({ status: 'COMMITTED' }),
      commitProject: async () => ({ status: 'COMMITTED' }),
      forgetGlobal: async () => {},
      forgetProject: async () => {},
    }
    const confinement: ConfinementPort = {
      readText: async () => '',
      writeText: async () => 0,
      editText: async () => ({ bytes: 0, replacements: 1 }),
      list: async () => [],
      scan: async () => ({ entries: 0, files: 0, directories: 0, totalBytes: 0 }),
    }
    const depsFor = (runtime: ReturnType<typeof makeRuntime>) => ({
      owner: OWNER,
      service: runtime.service,
      leases: runtime.leases,
      confinement,
      scopedMemory,
      buildRunner: (input: {
        lease: TurnContextLease
        grantBinding: ResolvedWorkBinding
        executeTool: (call: ToolCall) => Promise<ToolResult>
      }) => {
        built.push(input)
        return { handle: async () => ({ state: 'ok' as const, reply: '', narrowed: false }) }
      },
      executeNonContextTool: async () => ({ ok: true as const, output: 'fallback' }),
    })
    const approval = () => async () => ({ decision: 'rejected' as const })
    const interactive = makeInteractiveTurnRuntimeFactory(depsFor(first))
    const binding = await interactive.captureBinding('context')
    expect(binding).toMatchObject({
      projectId: projectSelection.projectId,
      scope: 'project',
    })
    expect(binding.sessionId).not.toBe(projectSelection.sessionId)

    const workspace = firstRegistry.listContexts(OWNER).find((item) => item.kind === 'workspace')!
    const current = firstRegistry.getActive(OWNER)
    const receipt = first.authority.issue({
      ...OWNER,
      targetProjectId: workspace.id,
      expectedGeneration: current.generation,
      sourceMessageHash: SOURCE_HASH,
    }, 30_000)
    const switched = await first.service.switchContext({
      ...OWNER,
      targetProjectId: workspace.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })

    const restartedRegistry = makeRegistry()
    const restarted = makeRuntime(restartedRegistry)
    const background = makeBackgroundTurnRuntimeFactory(depsFor(restarted))
    const turn = await background.acquire(binding, approval, { goal: true })
    expect(turn.sessionId).toBe(binding.sessionId)
    expect(built.at(-1)?.lease).toMatchObject({
      projectId: binding.projectId,
      sessionId: binding.sessionId,
      generation: switched.selection.generation,
      root: '/Users/operator/projects/project-a',
    })
    expect(built.at(-1)?.grantBinding).toEqual(binding)

    await built.at(-1)!.executeTool({ name: 'goal_done', args: {} })
    expect(turn.takeClaimedDone?.()).toBe(true)
    expect(turn.takeClaimedDone?.()).toBe(false)
    await expect(turn.recall?.('project fact')).resolves.toBe('')
    expect(memoryCalls.at(-1)).toMatchObject({
      projectId: binding.projectId,
      sessionId: binding.sessionId,
    })

    restartedRegistry.archiveSession({
      ...OWNER,
      projectId: binding.projectId,
      sessionId: binding.sessionId,
    })
    await expect(turn.recall?.('must stop')).rejects.toThrowError(
      expect.objectContaining({ code: 'STALE_CONTEXT' }),
    )
    expect(memoryCalls).toHaveLength(1)
    await turn.release?.()
    await expect(background.acquire(binding, approval)).rejects.toThrowError(
      expect.objectContaining({ code: 'SESSION_ARCHIVED' }),
    )
  })
})

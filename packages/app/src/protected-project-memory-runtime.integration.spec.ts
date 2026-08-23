import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeFreshProjectRegistryV2,
  type AgentRunner,
  type ProtectedMemoryScope,
  type ToolCall,
  type ToolResult,
} from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeNodeProjectRuntimeFromRegistry,
  makeNodeInteractiveTurnRuntimeFactory,
} from './project-service-runtime.js'
import { makeNodeProjectRegistryV2Store } from './project-registry-v2-store.js'
import {
  makeNodeProtectedMemoryPreviewRouter,
  makeNodeProtectedMemoryScopeRuntime,
  type NodeProtectedMemoryScopeRuntime,
} from './protected-memory-runtime.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const NOW = Date.parse('2026-07-27T11:00:00.000Z')
const roots: string[] = []
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('protected Project + memory preview composition', () => {
  it('persists two exact Project sessions across restart with negative cross-project/Workspace recall', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-protected-project-memory-')))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    const projectsRoot = join(root, 'projects')
    const controlRoot = join(root, '.aisy')
    const registryPath = join(controlRoot, 'projects-v2.json')
    const noncePath = join(controlRoot, 'authority', 'switch-nonces.json')
    const workerPath = join(root, 'confinement-worker.mjs')
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })
    writeFileSync(workerPath, `
      import { readFileSync } from 'node:fs'
      const request = JSON.parse(readFileSync(0, 'utf8'))
      process.stdout.write(JSON.stringify({
        version: 1,
        requestId: request.requestId,
        ok: true,
        data: request.op === 'scan'
          ? { entries: 0, files: 0, directories: 0, totalBytes: 0 }
          : { entries: [] },
      }))
    `, { mode: 0o700 })
    const policy = {
      homeRoot: root,
      projectsRoot,
      protectedRoots: [controlRoot],
    }
    let id = 0
    const initial = makeFreshProjectRegistryV2({
      ...OWNER,
      workspaceRoot,
      nowIso: () => new Date(NOW).toISOString(),
      newId: () => `registry-${++id}`,
      policy,
    })
    makeNodeProjectRegistryV2Store({ path: registryPath, policy }).saveAtomic(initial)
    let leaseId = 0
    let provisionId = 0
    const makeProjectRuntime = () => makeNodeProjectRuntimeFromRegistry({
      registryPath,
      registryPolicy: policy,
      authoritySecret: Buffer.alloc(32, 9),
      noncePath,
      projectsRoot,
      controlRoot,
      nowMs: () => NOW,
      nowIso: () => new Date(NOW).toISOString(),
      newRegistryId: () => `registry-${++id}`,
      newReceiptId: () => `receipt-${++id}`,
      newLeaseId: () => `lease-${++leaseId}`,
      newProvisioningId: () => `provision-${++provisionId}`,
      pythonExecutable: process.execPath,
      confinementWorkerPath: workerPath,
      newConfinementRequestId: () => `confinement-${++id}`,
    })
    const provisioningRuntime = makeProjectRuntime()
    const projectA = await provisioningRuntime.provisioner.createProject({
      ...OWNER,
      name: 'Изолированный проект Альфа',
    })
    const projectB = await provisioningRuntime.provisioner.createProject({
      ...OWNER,
      name: 'Изолированный проект Гамма',
    })
    const activeAfterCreate = provisioningRuntime.registry.getActive(OWNER)
    const selectASourceHash = 'a'.repeat(64)
    const selectAReceipt = provisioningRuntime.authority.issue({
      ...OWNER,
      targetProjectId: projectA.selection.projectId,
      targetSessionId: projectA.selection.sessionId,
      expectedGeneration: activeAfterCreate.generation,
      sourceMessageHash: selectASourceHash,
    }, 30_000)
    const selectedA = (await provisioningRuntime.service.switchContext({
      ...OWNER,
      targetProjectId: projectA.selection.projectId,
      targetSessionId: projectA.selection.sessionId,
      receipt: selectAReceipt,
      sourceMessageHash: selectASourceHash,
    })).selection
    const projectScopeA: ProtectedMemoryScope = {
      kind: 'project',
      scopeId: `project:${projectA.selection.projectId}`,
      projectId: projectA.selection.projectId,
    }
    const projectScopeB: ProtectedMemoryScope = {
      kind: 'project',
      scopeId: `project:${projectB.selection.projectId}`,
      projectId: projectB.selection.projectId,
    }
    const globalScope: ProtectedMemoryScope = { kind: 'global', scopeId: 'global' }
    const memoryPaths = (stateRoot: string, contentRoot: string) => ({
      ledger: join(stateRoot, 'ledger.sqlite'),
      keyword: join(stateRoot, 'keyword.sqlite'),
      semantic: join(stateRoot, 'semantic.sqlite'),
      barrier: join(stateRoot, 'barrier.sqlite'),
      contentRoot,
      stagingRoot: join(stateRoot, 'staging'),
    })
    const globalPaths = memoryPaths(join(controlRoot, 'memory', 'global'), workspaceRoot)
    const projectPathsA = memoryPaths(
      join(controlRoot, 'memory', 'projects', projectA.selection.projectId),
      projectA.root,
    )
    const projectPathsB = memoryPaths(
      join(controlRoot, 'memory', 'projects', projectB.selection.projectId),
      projectB.root,
    )
    const descriptor = {
      provider: 'openrouter' as const, modelId: 'test', modelRevision: '1', dimensions: 2,
      normalizationVersion: 'nfkc-v1', chunkerVersion: 'fact-v1',
    }
    let replacementId = 0
    const makeMemoryRuntime = (
      runtime: ReturnType<typeof makeProjectRuntime>,
      scope: ProtectedMemoryScope,
      paths: ReturnType<typeof memoryPaths>,
    ) => makeNodeProtectedMemoryScopeRuntime({
      mode: 'preview',
      paths,
      operatorId: OWNER.operatorId,
      profileId: OWNER.profileId,
      scope,
      leases: runtime.leases,
      descriptor,
      nowIso: () => new Date(NOW).toISOString(),
      newFactId: () => `replacement-${++replacementId}`,
      prepareFact: async ({ text }) => {
        const keyTokens = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
        return {
          factKey: sha256(keyTokens.join('|')),
          keyTokens,
          validAt: new Date(NOW).toISOString(),
          isHumanConfirmed: false,
          sourceAuthority: 50,
          confidence: 0.9,
        }
      },
      deliverPublicationAuditOnce: async () => undefined,
      deliverDeletionAuditOnce: async () => undefined,
      deliverUpdateAuditOnce: async () => undefined,
    })
    let factId = 0
    let openMemory: NodeProtectedMemoryScopeRuntime[] = []
    const makeTurnComposition = (projectRuntime: ReturnType<typeof makeProjectRuntime>) => {
      const globalMemory = makeMemoryRuntime(projectRuntime, globalScope, globalPaths)
      const projectMemoryA = makeMemoryRuntime(projectRuntime, projectScopeA, projectPathsA)
      const projectMemoryB = makeMemoryRuntime(projectRuntime, projectScopeB, projectPathsB)
      if (globalMemory.mode !== 'preview' || projectMemoryA.mode !== 'preview' ||
        projectMemoryB.mode !== 'preview') {
        throw new Error('preview memory runtimes expected')
      }
      openMemory = [globalMemory, projectMemoryA, projectMemoryB]
      const scopedMemory = makeNodeProtectedMemoryPreviewRouter({
        leases: projectRuntime.leases,
        globalRuntime: globalMemory,
        projectRuntime: (projectId) => {
          if (projectId === projectA.selection.projectId) return projectMemoryA
          if (projectId === projectB.selection.projectId) return projectMemoryB
          return null
        },
        newFactId: () => `fact-${++factId}`,
        provenanceFor: ({ lease, op, scope }) =>
          `${lease.sessionId}:${lease.generation}:${scope.scopeId}:${op.op}`,
        authorizeHumanConfirmedDelete: async () => false,
      })
      if (!scopedMemory) throw new Error('preview scoped router expected')
      let executeTool: ((call: ToolCall) => Promise<ToolResult>) | undefined
      const turns = makeNodeInteractiveTurnRuntimeFactory({
        runtime: projectRuntime,
        deps: {
          owner: OWNER,
          scopedMemory,
          buildRunner: (input) => {
            executeTool = input.executeTool
            return {
              handle: async () => ({ state: 'ok', reply: '', narrowed: false }),
            } satisfies AgentRunner
          },
          executeNonContextTool: async (_lease, call) => ({
            ok: true,
            output: `fallback:${call.name}`,
          }),
        },
      })
      return {
        globalMemory,
        projectMemoryA,
        projectMemoryB,
        turns,
        execute: () => {
          if (!executeTool) throw new Error('turn has not been acquired')
          return executeTool
        },
      }
    }

    try {
      const firstProjectRuntime = makeProjectRuntime()
      const first = makeTurnComposition(firstProjectRuntime)
      const firstTurn = await first.turns.acquire(
        () => async () => ({ decision: 'rejected' }),
      )
      expect(firstTurn.sessionId).toBe(selectedA.sessionId)
      await expect(first.execute()({
        name: 'remember',
        args: { text: 'Секретный проектный маяк Альфа' },
      })).resolves.toEqual({ ok: true, output: 'Запомнил.' })
      await expect(first.execute()({
        name: 'search_memory',
        args: { query: 'маяк' },
      })).resolves.toMatchObject({
        ok: true,
        output: expect.stringContaining('[project:'),
      })
      await firstTurn.release?.()
      first.projectMemoryA.close()
      first.projectMemoryB.close()
      first.globalMemory.close()
      openMemory = []

      const restartedProjectRuntime = makeProjectRuntime()
      expect(restartedProjectRuntime.registry.getActive(OWNER)).toEqual(selectedA)
      const restarted = makeTurnComposition(restartedProjectRuntime)
      const restartedTurn = await restarted.turns.acquire(
        () => async () => ({ decision: 'rejected' }),
      )
      await expect(restarted.execute()({
        name: 'search_memory',
        args: { query: 'Альфа' },
      })).resolves.toMatchObject({
        ok: true,
        output: expect.stringContaining('Секретный проектный маяк Альфа'),
      })
      await restartedTurn.release?.()

      const activeA = restartedProjectRuntime.registry.getActive(OWNER)
      const selectBSourceHash = 'b'.repeat(64)
      const selectBReceipt = restartedProjectRuntime.authority.issue({
        ...OWNER,
        targetProjectId: projectB.selection.projectId,
        targetSessionId: projectB.selection.sessionId,
        expectedGeneration: activeA.generation,
        sourceMessageHash: selectBSourceHash,
      }, 30_000)
      await restartedProjectRuntime.service.switchContext({
        ...OWNER,
        targetProjectId: projectB.selection.projectId,
        targetSessionId: projectB.selection.sessionId,
        receipt: selectBReceipt,
        sourceMessageHash: selectBSourceHash,
      })
      const projectBTurn = await restarted.turns.acquire(
        () => async () => ({ decision: 'rejected' }),
      )
      expect(projectBTurn.sessionId).toBe(projectB.selection.sessionId)
      await expect(restarted.execute()({
        name: 'search_memory',
        args: { query: 'Альфа' },
      })).resolves.toEqual({ ok: true, output: 'Память: ничего не найдено.' })
      await expect(restarted.execute()({
        name: 'remember',
        args: { text: 'Секретный проектный маяк Гамма' },
      })).resolves.toEqual({ ok: true, output: 'Запомнил.' })
      await expect(restarted.execute()({
        name: 'search_memory',
        args: { query: 'Гамма' },
      })).resolves.toMatchObject({
        ok: true,
        output: expect.stringContaining('Секретный проектный маяк Гамма'),
      })
      await projectBTurn.release?.()

      const workspace = restartedProjectRuntime.registry.listContexts(OWNER).find(
        (item) => item.kind === 'workspace',
      )!
      const active = restartedProjectRuntime.registry.getActive(OWNER)
      const sourceMessageHash = 'f'.repeat(64)
      const receipt = restartedProjectRuntime.authority.issue({
        ...OWNER,
        targetProjectId: workspace.id,
        expectedGeneration: active.generation,
        sourceMessageHash,
      }, 30_000)
      await restartedProjectRuntime.service.switchContext({
        ...OWNER,
        targetProjectId: workspace.id,
        receipt,
        sourceMessageHash,
      })
      const workspaceTurn = await restarted.turns.acquire(
        () => async () => ({ decision: 'rejected' }),
      )
      expect(workspaceTurn.sessionId).toBe(
        restartedProjectRuntime.registry.getActive(OWNER).sessionId,
      )
      await expect(restarted.execute()({
        name: 'search_memory',
        args: { query: 'Альфа' },
      })).resolves.toEqual({ ok: true, output: 'Память: ничего не найдено.' })
      await expect(restarted.execute()({
        name: 'search_memory',
        args: { query: 'Гамма' },
      })).resolves.toEqual({ ok: true, output: 'Память: ничего не найдено.' })
      await expect(restarted.execute()({
        name: 'remember',
        args: { text: 'Глобальный маяк Бета' },
      })).resolves.toEqual({ ok: true, output: 'Запомнил.' })
      await expect(restarted.execute()({
        name: 'search_memory',
        args: { query: 'Бета' },
      })).resolves.toMatchObject({
        ok: true,
        output: expect.stringContaining('[global:'),
      })
      await workspaceTurn.release?.()
      await expect(restarted.projectMemoryA.store.listLiveFacts()).resolves.toHaveLength(1)
      await expect(restarted.projectMemoryB.store.listLiveFacts()).resolves.toHaveLength(1)
      await expect(restarted.globalMemory.store.listLiveFacts()).resolves.toHaveLength(1)
    } finally {
      for (const runtime of openMemory) {
        if (runtime.mode === 'preview') runtime.close()
      }
    }
  })
})

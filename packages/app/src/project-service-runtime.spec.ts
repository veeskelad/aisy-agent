import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  makeFreshProjectRegistryV2,
  makeProjectRegistryV2,
  type ScopedMemoryRouter,
  type ToolCall,
  type ToolResult,
  type TurnContextLease,
  type ProjectRegistryStateV2,
} from '@aisy/core'
import {
  makeNodeInteractiveTurnRuntimeFactory,
  makeNodeProjectServiceRuntime,
  makeNodeProjectServiceRuntimeFromRegistry,
  makeNodeProjectRuntimeFromRegistry,
} from './project-service-runtime.js'
import { makeNodeProjectLifecycleAuthorityRuntime } from './project-lifecycle-authority-runtime.js'
import { makeNodeProjectRegistryV2Store } from './project-registry-v2-store.js'

const OWNER = { operatorId: 'telegram:42', profileId: 'default' }
const POLICY = {
  homeRoot: '/Users/operator',
  projectsRoot: '/Users/operator/projects',
  protectedRoots: ['/Users/operator/.aisy'],
}
const NOW = Date.parse('2026-07-26T21:00:00.000Z')
const SOURCE_HASH = 'd'.repeat(64)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('makeNodeProjectServiceRuntime', () => {
  it('persists one-use switch authority across a full runtime restart', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'aisy-project-service-'))
    roots.push(stateRoot)
    let id = 0
    let durable: ProjectRegistryStateV2 = makeFreshProjectRegistryV2({
      ...OWNER,
      workspaceRoot: '/Users/operator/workspace',
      nowIso: () => new Date(NOW).toISOString(),
      newId: () => `id-${++id}`,
      policy: POLICY,
    })
    const makeRegistry = () => makeProjectRegistryV2({
      state: durable,
      policy: POLICY,
      nowIso: () => new Date(NOW).toISOString(),
      newId: () => `id-${++id}`,
      persistence: { saveAtomic: (state) => { durable = state } },
    })
    const firstRegistry = makeRegistry()
    const targetSelection = firstRegistry.createProject({
      ...OWNER,
      name: 'Project B',
      slug: 'project-b',
      root: '/Users/operator/projects/project-b',
      origin: 'created',
    })
    const workspace = firstRegistry.listContexts(OWNER).find((item) => item.kind === 'workspace')!
    firstRegistry.switchContext({
      ...OWNER,
      projectId: workspace.id,
      expectedGeneration: targetSelection.generation,
    })
    const target = firstRegistry.listContexts(OWNER).find(
      (item) => item.id === targetSelection.projectId,
    )!
    const noncePath = join(stateRoot, 'authority', 'switch-nonces.json')
    const secret = Buffer.alloc(32, 4)
    const firstRuntime = makeNodeProjectServiceRuntime({
      registry: firstRegistry,
      authoritySecret: secret,
      noncePath,
      nowMs: () => NOW,
      newReceiptId: () => 'receipt-restart',
      newLeaseId: () => 'lease-before-restart',
    })
    const before = firstRegistry.getActive(OWNER)
    const binding = {
      ...OWNER,
      targetProjectId: target.id,
      expectedGeneration: before.generation,
      sourceMessageHash: SOURCE_HASH,
    }
    const receipt = firstRuntime.authority.issue(binding, 30_000)

    const restartedRegistry = makeRegistry()
    let leaseId = 0
    const restartedRuntime = makeNodeProjectServiceRuntime({
      registry: restartedRegistry,
      authoritySecret: secret,
      noncePath,
      nowMs: () => NOW,
      newReceiptId: () => 'unused',
      newLeaseId: () => `lease-${++leaseId}`,
    })
    const result = await restartedRuntime.service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })

    expect(result.selection).toMatchObject({
      projectId: target.id,
      generation: before.generation + 1,
    })
    const afterSecondRestart = makeNodeProjectServiceRuntime({
      registry: makeRegistry(),
      authoritySecret: secret,
      noncePath,
      nowMs: () => NOW,
      newReceiptId: () => 'unused-again',
      newLeaseId: () => 'lease-after-second-restart',
    })
    expect(afterSecondRestart.authority.isIssued(receipt)).toBe(false)
    await expect(afterSecondRestart.service.switchContext({
      ...OWNER,
      targetProjectId: target.id,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })).rejects.toBeTruthy()
    expect(makeRegistry().getActive(OWNER).generation).toBe(result.selection.generation)
  })

  it('restores exact project, session, and generation from the durable v2 registry', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'aisy-project-registry-'))
    roots.push(stateRoot)
    const registryPath = join(stateRoot, 'registry', 'projects-v2.json')
    const noncePath = join(stateRoot, 'authority', 'switch-nonces.json')
    let id = 0
    const initial = makeFreshProjectRegistryV2({
      ...OWNER,
      workspaceRoot: '/Users/operator/workspace',
      nowIso: () => new Date(NOW).toISOString(),
      newId: () => `id-${++id}`,
      policy: POLICY,
    })
    makeNodeProjectRegistryV2Store({ path: registryPath, policy: POLICY }).saveAtomic(initial)
    const secret = Buffer.alloc(32, 5)
    let leaseId = 0
    const makeRuntime = () => makeNodeProjectServiceRuntimeFromRegistry({
      registryPath,
      registryPolicy: POLICY,
      authoritySecret: secret,
      noncePath,
      nowMs: () => NOW,
      nowIso: () => new Date(NOW).toISOString(),
      newRegistryId: () => `id-${++id}`,
      newReceiptId: () => `receipt-${id}`,
      newLeaseId: () => `lease-${++leaseId}`,
    })
    const first = makeRuntime()
    const projectSelection = first.registry.createProject({
      ...OWNER,
      name: 'Project B',
      slug: 'project-b',
      root: '/Users/operator/projects/project-b',
      origin: 'created',
    })
    const workspace = first.registry.listContexts(OWNER).find((item) => item.kind === 'workspace')!
    first.registry.switchContext({
      ...OWNER,
      projectId: workspace.id,
      expectedGeneration: projectSelection.generation,
    })
    const before = first.registry.getActive(OWNER)
    const receipt = first.authority.issue({
      ...OWNER,
      targetProjectId: projectSelection.projectId,
      expectedGeneration: before.generation,
      sourceMessageHash: SOURCE_HASH,
    }, 30_000)

    const afterFirstRestart = makeRuntime()
    expect(afterFirstRestart.registry.getActive(OWNER)).toEqual(before)
    const switched = await afterFirstRestart.service.switchContext({
      ...OWNER,
      targetProjectId: projectSelection.projectId,
      receipt,
      sourceMessageHash: SOURCE_HASH,
    })

    const afterSecondRestart = makeRuntime()
    expect(afterSecondRestart.registry.getActive(OWNER)).toEqual(switched.selection)
    expect(afterSecondRestart.service.acquireTurnContext(OWNER)).toMatchObject({
      projectId: switched.selection.projectId,
      sessionId: switched.selection.sessionId,
      generation: switched.selection.generation,
    })
    expect(afterSecondRestart.authority.isIssued(receipt)).toBe(false)
  })

  it('persists active Project archive, Workspace replacement, and non-selecting restore across restart', async () => {
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-project-lifecycle-')))
    roots.push(stateRoot)
    const registryPath = join(stateRoot, 'registry', 'projects-v2.json')
    const noncePath = join(stateRoot, 'authority', 'switch-nonces.json')
    const lifecycleNoncePath = join(stateRoot, 'authority', 'lifecycle-nonces.json')
    let id = 0
    const initial = makeFreshProjectRegistryV2({
      ...OWNER,
      workspaceRoot: '/Users/operator/workspace',
      nowIso: () => new Date(NOW).toISOString(),
      newId: () => `id-${++id}`,
      policy: POLICY,
    })
    makeNodeProjectRegistryV2Store({ path: registryPath, policy: POLICY }).saveAtomic(initial)
    const checkedRoots: string[] = []
    const secret = Buffer.alloc(32, 11)
    const lifecycleSecret = Buffer.alloc(32, 12)
    let leaseId = 0
    let lifecycleId = 0
    const makeRuntime = () => {
      const lifecycle = makeNodeProjectLifecycleAuthorityRuntime({
        secret: lifecycleSecret,
        noncePath: lifecycleNoncePath,
        nowMs: () => NOW,
        newReceiptId: () => `lifecycle-${++lifecycleId}`,
        validateRestorableRoot(project) {
          checkedRoots.push(project.root)
        },
      })
      return {
        ...makeNodeProjectServiceRuntimeFromRegistry({
          registryPath,
          registryPolicy: POLICY,
          authoritySecret: secret,
          noncePath,
          nowMs: () => NOW,
          nowIso: () => new Date(NOW).toISOString(),
          newRegistryId: () => `id-${++id}`,
          newReceiptId: () => `switch-${++id}`,
          newLeaseId: () => `lease-${++leaseId}`,
          lifecycle: lifecycle.lifecycle,
        }),
        lifecycleAuthority: lifecycle.authority,
      }
    }
    const first = makeRuntime()
    const created = first.registry.createProject({
      ...OWNER,
      name: 'Project B',
      slug: 'project-b',
      root: '/Users/operator/projects/project-b',
      origin: 'created',
    })
    const lifecycleReceipt = first.lifecycleAuthority.issue({
      ...OWNER,
      action: 'project.archive',
      projectId: created.projectId,
      expectedGeneration: created.generation,
      sourceMessageHash: SOURCE_HASH,
    }, 30_000)

    const archived = await first.service.archiveProject({
      ...OWNER,
      projectId: created.projectId,
      receipt: lifecycleReceipt,
      sourceMessageHash: SOURCE_HASH,
    })
    const restarted = makeRuntime()
    expect(restarted.registry.getActive(OWNER)).toEqual(archived.selection)
    expect(restarted.registry.listContexts(OWNER, true)
      .find((item) => item.id === created.projectId)?.archivedAt).toBeDefined()
    expect(restarted.service.acquireTurnContext(OWNER)).toMatchObject(archived.selection)
    expect(() => restarted.lifecycleAuthority.consume(lifecycleReceipt, {
      ...OWNER,
      action: 'project.archive',
      projectId: created.projectId,
      expectedGeneration: created.generation,
      sourceMessageHash: SOURCE_HASH,
    })).toThrowError(expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }))

    const beforeRestore = restarted.registry.getActive(OWNER)
    const restored = await restarted.service.restoreProject({
      ...OWNER,
      projectId: created.projectId,
    })
    expect(restored.archivedAt).toBeUndefined()
    expect(checkedRoots).toEqual(['/Users/operator/projects/project-b'])
    expect(restarted.registry.getActive(OWNER)).toEqual(beforeRestore)

    const afterRestoreRestart = makeRuntime()
    expect(afterRestoreRestart.registry.getActive(OWNER)).toEqual(beforeRestore)
    expect(afterRestoreRestart.registry.listContexts(OWNER)
      .some((item) => item.id === created.projectId)).toBe(true)
  })

  it('composes staged project creation with durable registry and restart recovery', async () => {
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-project-composition-')))
    roots.push(stateRoot)
    const policy = {
      homeRoot: stateRoot,
      projectsRoot: join(stateRoot, 'projects'),
      protectedRoots: [join(stateRoot, '.aisy')],
    }
    const workspaceRoot = join(stateRoot, 'workspace')
    const registryPath = join(stateRoot, '.aisy', 'projects-v2.json')
    const noncePath = join(stateRoot, '.aisy', 'authority', 'switch-nonces.json')
    const workerPath = join(stateRoot, 'confinement-worker.mjs')
    writeFileSync(workerPath, `
      import { readFileSync } from 'node:fs'
      const request = JSON.parse(readFileSync(0, 'utf8'))
      const data = request.op === 'list'
        ? { entries: ['knowledge'] }
        : { entries: 8, files: 3, directories: 5, totalBytes: 256 }
      process.stdout.write(JSON.stringify({
        version: 1, requestId: request.requestId, ok: true, data,
      }))
    `, { mode: 0o700 })
    let id = 0
    mkdirSync(workspaceRoot, { mode: 0o700 })
    const initial = makeFreshProjectRegistryV2({
      ...OWNER,
      workspaceRoot,
      nowIso: () => new Date(NOW).toISOString(),
      newId: () => `id-${++id}`,
      policy,
    })
    makeNodeProjectRegistryV2Store({ path: registryPath, policy }).saveAtomic(initial)
    const secret = Buffer.alloc(32, 8)
    let leaseId = 0
    let provisionId = 0
    const makeRuntime = () => makeNodeProjectRuntimeFromRegistry({
      registryPath,
      registryPolicy: policy,
      authoritySecret: secret,
      noncePath,
      projectsRoot: policy.projectsRoot,
      controlRoot: join(stateRoot, '.aisy'),
      nowMs: () => NOW,
      nowIso: () => new Date(NOW).toISOString(),
      newRegistryId: () => `id-${++id}`,
      newReceiptId: () => `receipt-${id}`,
      newLeaseId: () => `lease-${++leaseId}`,
      newProvisioningId: () => `provision-${++provisionId}`,
      pythonExecutable: process.execPath,
      confinementWorkerPath: workerPath,
      newConfinementRequestId: () => `confinement-${++id}`,
    })

    const created = await makeRuntime().provisioner.createProject({
      ...OWNER,
      name: 'Новый проект',
    })
    const restarted = makeRuntime()

    expect(restarted.registry.getActive(OWNER)).toEqual(created.selection)
    expect(restarted.service.acquireTurnContext(OWNER)).toMatchObject({
      root: created.root,
      projectId: created.selection.projectId,
      sessionId: created.selection.sessionId,
      generation: created.selection.generation,
    })
    expect(existsSync(join(created.root, 'memory', 'facts'))).toBe(true)
    expect(existsSync(join(created.root, 'knowledge', 'INDEX.md'))).toBe(true)
    expect(readFileSync(join(workspaceRoot, 'PROJECTS.md'), 'utf8')).toContain('Новый проект')
    let executeTool: ((call: ToolCall) => Promise<ToolResult>) | undefined
    let turnLease: TurnContextLease | undefined
    const scopedMemory: ScopedMemoryRouter = {
      searchAutomatic: async () => ({
        requestedMode: 'keyword', effectiveMode: 'keyword', status: 'OK', hits: [],
      }),
      commitGlobal: async () => ({ status: 'COMMITTED' }),
      commitProject: async () => ({ status: 'COMMITTED' }),
      forgetGlobal: async () => {},
      forgetProject: async () => {},
    }
    const turnFactory = makeNodeInteractiveTurnRuntimeFactory({
      runtime: restarted,
      deps: {
        owner: OWNER,
        scopedMemory,
        buildRunner: (input) => {
          executeTool = input.executeTool
          turnLease = input.lease
          return { handle: async () => ({ state: 'ok', reply: '', narrowed: false }) }
        },
        executeNonContextTool: async (_lease, call) => ({
          ok: true,
          output: `fallback:${call.name}`,
        }),
      },
    })
    const turn = await turnFactory.acquire(
      () => async () => ({ decision: 'rejected' }),
    )
    expect(turn.sessionId).toBe(created.selection.sessionId)
    await expect(executeTool?.({ name: 'list_dir', args: {} })).resolves.toEqual({
      ok: true,
      output: 'knowledge',
    })
    const workspace = restarted.registry.listContexts(OWNER).find(
      (item) => item.kind === 'workspace',
    )!
    const active = restarted.registry.getActive(OWNER)
    const sourceMessageHash = 'e'.repeat(64)
    const receipt = restarted.authority.issue({
      ...OWNER,
      targetProjectId: workspace.id,
      expectedGeneration: active.generation,
      sourceMessageHash,
    }, 30_000)
    let switchSettled = false
    const switching = restarted.service.switchContext({
      ...OWNER,
      targetProjectId: workspace.id,
      receipt,
      sourceMessageHash,
    }).then((result) => {
      switchSettled = true
      return result
    })
    await Promise.resolve()
    expect(switchSettled).toBe(false)
    await expect(executeTool?.({ name: 'list_dir', args: {} })).resolves.toEqual({
      ok: false,
      output: 'list_dir: STALE_CONTEXT',
    })
    await turn.release?.()
    const switched = await switching
    expect(switched.selection).toMatchObject({
      projectId: workspace.id,
      generation: active.generation + 1,
    })

    const workspaceTurn = await turnFactory.acquire(
      () => async () => ({ decision: 'rejected' }),
    )
    expect(workspaceTurn.sessionId).toBe(switched.selection.sessionId)
    expect(turnLease).toMatchObject({
      projectId: workspace.id,
      sessionId: workspaceTurn.sessionId,
      generation: switched.selection.generation,
      root: workspace.root,
    })
    await workspaceTurn.release?.()
  })
})

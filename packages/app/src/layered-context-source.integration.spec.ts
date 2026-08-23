import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  makeAgentRunner,
  makeConfinementPort,
  makeContextLeaseCoordinator,
  makeGrantStore,
  makeLayeredContextAssembler,
  type ModelRequest,
  type ProjectService,
  type ResolvedWorkBinding,
  type ScopedMemoryRouter,
  type TurnContextLease,
} from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeConfinementProcessPort } from './confinement-sidecar.js'
import { makeInteractiveTurnRuntimeFactory } from './interactive-turn-runtime.js'
import {
  makeLeaseBoundLayeredContextSource,
  makeWorkspaceLazyContextReader,
} from './layered-context-source.js'

const pythonExecutable = resolve(process.cwd(), '../sidecars-py/.venv/bin/python')
const workerPath = resolve(
  process.cwd(),
  '../sidecars-py/aisy_sidecars/confinement_worker.py',
)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.runIf(existsSync(pythonExecutable) && existsSync(workerPath))(
  'layered context Node composition',
  () => {
    it('reads exact Workspace and Project roots into the real AgentRunner model request', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-layered-context-')))
      roots.push(root)
      const workspaceRoot = join(root, 'workspace')
      const projectRoot = join(root, 'project-a')
      mkdirSync(join(workspaceRoot, 'memory', 'facts'), { recursive: true })
      mkdirSync(join(workspaceRoot, 'knowledge'), { recursive: true })
      mkdirSync(join(projectRoot, 'memory', 'facts'), { recursive: true })
      mkdirSync(join(projectRoot, 'knowledge'), { recursive: true })
      writeFileSync(join(workspaceRoot, 'memory', '2026-07-27.md'), 'global journal')
      writeFileSync(join(workspaceRoot, 'knowledge', 'INDEX.md'), 'global knowledge')
      writeFileSync(join(workspaceRoot, 'memory', 'facts', 'global.md'), 'global fact')
      writeFileSync(join(projectRoot, '.current-task.md'), 'active task')
      writeFileSync(join(projectRoot, 'memory', '2026-07-27.md'), 'project journal')
      writeFileSync(join(projectRoot, 'memory', 'INDEX.md'), 'project memory index')
      writeFileSync(join(projectRoot, 'knowledge', 'INDEX.md'), 'project knowledge')
      writeFileSync(join(projectRoot, 'memory', 'facts', 'project.md'), 'project fact')

      const owner = { operatorId: 'telegram:42', profileId: 'default' }
      let id = 0
      const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++id}` })
      const projectInput = {
        ...owner,
        projectId: 'project-a',
        projectKind: 'project' as const,
        sessionId: 'project-session',
        root: projectRoot,
        generation: 7,
      }
      const workspaceInput = {
        ...owner,
        projectId: 'workspace-a',
        projectKind: 'workspace' as const,
        sessionId: 'workspace-session',
        root: workspaceRoot,
        generation: 3,
      }
      const workspaceBinding: ResolvedWorkBinding = {
        ...owner,
        projectId: workspaceInput.projectId,
        sessionId: workspaceInput.sessionId,
        scope: 'workspace',
      }
      const service = {
        acquireTurnContext: () => leases.acquire(projectInput),
        acquireBoundContext: () => leases.acquire(workspaceInput),
        assertBoundContext: (lease: TurnContextLease, binding: ResolvedWorkBinding) => {
          expect(lease).toMatchObject({
            operatorId: binding.operatorId,
            profileId: binding.profileId,
            projectId: binding.projectId,
            sessionId: binding.sessionId,
            projectKind: binding.scope,
          })
        },
        releaseTurnContext: (lease: TurnContextLease) => leases.quiesceAndClose(lease),
      } as unknown as ProjectService
      const confinement = makeConfinementPort({
        leases,
        process: makeNodeConfinementProcessPort({ pythonExecutable, workerPath }),
        newId: () => `request-${++id}`,
      })
      const scopedMemory: ScopedMemoryRouter = {
        searchAutomatic: async (lease, query) => {
          expect(lease).toMatchObject(projectInput)
          expect(query).toBe('мой запрос')
          return {
            requestedMode: 'keyword', effectiveMode: 'keyword', status: 'OK', hits: [
              {
                id: 'global', factKey: 'global', text: 'global fact', score: -2,
                scope: 'global', scopeId: 'global',
                sourcePath: 'memory/facts/global.md', provenanceRef: 'publication:global',
                componentRanks: { keyword: 1 },
              },
              {
                id: 'project', factKey: 'project', text: 'project fact', score: -1,
                scope: 'project', scopeId: 'project:project-a', projectId: 'project-a',
                sourcePath: 'memory/facts/project.md', provenanceRef: 'publication:project',
                componentRanks: { keyword: 2 },
              },
            ],
          }
        },
        commitGlobal: async () => ({ status: 'COMMITTED' }),
        commitProject: async () => ({ status: 'COMMITTED' }),
        forgetGlobal: async () => {},
        forgetProject: async () => {},
      }
      const source = makeLeaseBoundLayeredContextSource({
        workspaceFiles: makeWorkspaceLazyContextReader({
          service,
          confinement,
          binding: workspaceBinding,
        }),
        projectFiles: confinement,
        memory: scopedMemory,
        nowIso: () => '2026-07-27T15:00:00.000Z',
        limits: { fileBytes: 4096, memoryHits: 8 },
      })
      const layeredContext = makeLayeredContextAssembler({ leases, source })
      const requests: ModelRequest[] = []
      const factory = makeInteractiveTurnRuntimeFactory({
        owner,
        service,
        leases,
        confinement,
        scopedMemory,
        layeredContext,
        buildRunner: ({ grantBinding, approve, executeTool }) => makeAgentRunner({
          provider: {
            complete: async request => {
              requests.push(structuredClone(request))
              return { reply: 'ok' }
            },
          },
          memory: {
            snapshot: async () => ({
              prefixBytes: new Uint8Array(), prefixHash: 'empty', breakpoints: [], takenAt: 'now',
            }),
            forget: async () => {},
          },
          grants: makeGrantStore(),
          grantBinding,
          executeTool,
          approve,
          guardian: { observe: () => ({ trip: false }), note: () => {} },
          sessionLog: { append: () => {}, resume: () => null },
        }),
        executeNonContextTool: async () => ({ ok: false, output: 'disabled' }),
      })

      const runtime = await factory.acquire(() => async () => ({ decision: 'rejected' }))
      await expect(runtime.runner.handle({
        sessionId: projectInput.sessionId,
        spans: [{ role: 'user', provenance: 'operator', text: 'мой запрос' }],
      })).resolves.toMatchObject({ reply: 'ok', state: 'ok' })
      await runtime.release?.()

      expect(requests).toHaveLength(1)
      expect(requests[0]?.spans.map(span => span.text)).toEqual([
        'мой запрос',
        expect.stringContaining('global journal'),
        expect.stringContaining('global knowledge'),
        expect.stringContaining('global fact'),
        expect.stringContaining('active task'),
        expect.stringContaining('project journal'),
        expect.stringContaining('project memory index'),
        expect.stringContaining('project knowledge'),
        expect.stringContaining('project fact'),
      ])
      expect(requests[0]?.spans.slice(1).every(span =>
        span.role === 'user' && span.provenance === 'untrusted')).toBe(true)
    })
  },
)

import { createHash } from 'node:crypto'
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
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AttachmentImportError,
  ConfinementError,
  makeConfinementPort,
  makeProjectRegistryV2,
  type AgentRunner,
  type ProjectRegistryStateV2,
  type ProjectRegistryV2Policy,
  type ScopedMemoryRouter,
  type ToolCall,
  type ToolResult,
} from '@aisy/core'
import {
  makeNodeAttachmentAwareInteractiveTurnRuntimeFactory,
  makeNodeProjectServiceRuntime,
} from './project-service-runtime.js'
import { makeNodeConfinementProcessPort } from './confinement-sidecar.js'
import { makeNodeAttachmentImportRuntime } from './attachment-import-runtime.js'
import {
  makeNodeAttachmentWorkerProcessPort,
  type AttachmentWorkerProcessPort,
} from './attachment-import-sidecar.js'
import type { AttachmentImportStoreFault } from './attachment-import-store.js'

const pythonExecutable = resolve(process.cwd(), '../sidecars-py/.venv/bin/python')
const workerPath = resolve(process.cwd(), '../sidecars-py/aisy_sidecars/attachment_worker.py')
const confinementWorkerPath = resolve(
  process.cwd(),
  '../sidecars-py/aisy_sidecars/confinement_worker.py',
)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(sessionId = 'session-a') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-attachment-runtime-')))
  roots.push(root)
  const homeRoot = join(root, 'home')
  const projectsRoot = join(homeRoot, 'projects')
  const workspaceRoot = join(homeRoot, 'workspace')
  const projectRoot = join(projectsRoot, 'project-a')
  const controlRoot = join(homeRoot, '.aisy')
  const inboxRoot = join(controlRoot, 'inbox')
  for (const directory of [projectsRoot, workspaceRoot, projectRoot, controlRoot,
    join(inboxRoot, 'records'), join(inboxRoot, 'objects')]) mkdirSync(directory, { recursive: true })
  const policy: ProjectRegistryV2Policy = {
    homeRoot,
    projectsRoot,
    protectedRoots: [controlRoot],
  }
  const state: ProjectRegistryStateV2 = {
    version: 2,
    projects: [
      {
        id: 'workspace-a', operatorId: 'telegram:42', profileId: 'default',
        kind: 'workspace', origin: 'workspace', name: 'Workspace', root: workspaceRoot,
        createdAt: '2026-07-27T04:00:00.000Z',
      },
      {
        id: 'project-a', operatorId: 'telegram:42', profileId: 'default',
        kind: 'project', origin: 'created', name: 'Project A', slug: 'project-a',
        root: projectRoot, createdAt: '2026-07-27T04:00:00.000Z',
      },
    ],
    sessions: [
      {
        id: 'workspace-session', projectId: 'workspace-a', name: 'Workspace', status: 'active',
        createdAt: '2026-07-27T04:00:00.000Z', updatedAt: '2026-07-27T04:00:00.000Z',
      },
      {
        id: 'session-a', projectId: 'project-a', name: 'Session A', status: 'active',
        createdAt: '2026-07-27T04:00:00.000Z', updatedAt: '2026-07-27T04:00:00.000Z',
      },
    ],
    selections: [{
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      sessionId: 'session-a', generation: 1,
    }],
  }
  let generated = 0
  const registry = makeProjectRegistryV2({
    state,
    policy,
    nowIso: () => '2026-07-27T04:01:00.000Z',
    newId: () => `generated-${++generated}`,
  })
  const projectRuntime = makeNodeProjectServiceRuntime({
    registry,
    authoritySecret: new Uint8Array(32).fill(7),
    noncePath: join(controlRoot, 'switch-nonces.json'),
    newReceiptId: () => `receipt-${++generated}`,
    newLeaseId: () => `lease-${++generated}`,
  })
  const lease = projectRuntime.service.acquireTurnContext({
    operatorId: 'telegram:42',
    profileId: 'default',
  })
  const payload = Buffer.from([0, 255, 65, 105, 115, 121, 10, 128])
  const sha256 = createHash('sha256').update(payload).digest('hex')
  writeFileSync(join(inboxRoot, 'objects', 'upload-1'), payload)
  writeFileSync(join(inboxRoot, 'records', 'upload-1.json'), JSON.stringify({
    schemaVersion: 1,
    fileId: 'upload-1',
    operatorId: 'telegram:42',
    profileId: 'default',
    sessionId,
    source: 'telegram',
    originalName: '../../hostile.bin',
    sha256,
    sizeBytes: payload.byteLength,
    provenanceRef: 'telegram:update:500',
    receivedAt: '2026-07-27T04:00:30.000Z',
  }))
  return {
    controlRoot,
    inboxRoot,
    lease,
    payload,
    projectRoot,
    projectRuntime,
    sha256,
  }
}

function runtime(input: ReturnType<typeof fixture>, options: {
  process?: AttachmentWorkerProcessPort
  faultAtStore?: (point: AttachmentImportStoreFault) => void
  faultAtFile?: (point: 'after-stage' | 'after-install') => void
} = {}) {
  let request = 0
  return makeNodeAttachmentImportRuntime({
    runtime: input.projectRuntime,
    controlRoot: input.controlRoot,
    inboxRoot: input.inboxRoot,
    pythonExecutable,
    workerPath,
    maxAttachmentBytes: 1024 * 1024,
    newRequestId: () => `request-${++request}`,
    nowIso: () => '2026-07-27T04:01:00.000Z',
    ...options,
  })
}

describe.runIf(existsSync(pythonExecutable) && existsSync(workerPath))(
  'Node attachment import production composition',
  () => {
    it('imports arbitrary binary, publishes durable metadata and resumes after restart', async () => {
      const f = fixture()
      const first = runtime(f)

      const imported = await first.service.importAttachment(f.lease, 'upload-1', 'knowledge')
      const restarted = runtime(f)
      const resumed = await restarted.service.importAttachment(f.lease, 'upload-1', 'knowledge')

      expect(imported).toMatchObject({
        relativePath: 'knowledge/imports/upload-1',
        originalName: '../../hostile.bin',
        sha256: f.sha256,
        provenance: 'untrusted',
        published: true,
      })
      expect(resumed).toEqual(imported)
      expect(readFileSync(join(f.projectRoot, imported.relativePath))).toEqual(f.payload)
      await expect(restarted.persistence.loadWal(imported.operationId)).resolves.toBeNull()
      await expect(restarted.persistence.loadManifest(imported.operationId)).resolves.toEqual(imported)
    }, 15_000)

    it('exposes import_attachment through the exact turn lease and manifest-aware files after restart', async () => {
      const f = fixture()
      const payload = Buffer.from('project attachment text', 'utf8')
      const payloadHash = createHash('sha256').update(payload).digest('hex')
      writeFileSync(join(f.inboxRoot, 'objects', 'upload-1'), payload)
      const inboxRecordPath = join(f.inboxRoot, 'records', 'upload-1.json')
      const inboxRecord = JSON.parse(readFileSync(inboxRecordPath, 'utf8')) as Record<string, unknown>
      writeFileSync(inboxRecordPath, JSON.stringify({
        ...inboxRecord,
        sha256: payloadHash,
        sizeBytes: payload.byteLength,
      }))
      const baseConfinement = makeConfinementPort({
        leases: f.projectRuntime.leases,
        process: makeNodeConfinementProcessPort({
          pythonExecutable,
          workerPath: confinementWorkerPath,
        }),
        newId: (() => {
          let id = 0
          return () => `tool-confinement-${++id}`
        })(),
      })
      const memory: ScopedMemoryRouter = {
        searchAutomatic: async () => ({
          requestedMode: 'keyword', effectiveMode: 'keyword', status: 'OK', hits: [],
        }),
        commitGlobal: async () => ({ status: 'COMMITTED' }),
        commitProject: async () => ({ status: 'COMMITTED' }),
        forgetGlobal: async () => undefined,
        forgetProject: async () => undefined,
      }
      const compose = (attachments: ReturnType<typeof runtime>) => {
        let execute: ((call: ToolCall) => Promise<ToolResult>) | undefined
        const turns = makeNodeAttachmentAwareInteractiveTurnRuntimeFactory({
          runtime: {
            service: f.projectRuntime.service,
            leases: f.projectRuntime.leases,
            confinement: baseConfinement,
          },
          attachments,
          deps: {
            owner: { operatorId: 'telegram:42', profileId: 'default' },
            scopedMemory: memory,
            buildRunner(input) {
              execute = input.executeTool
              return {
                handle: async () => ({ state: 'ok', reply: '', narrowed: false }),
              } satisfies AgentRunner
            },
            executeNonContextTool: async (_lease, call) => ({
              ok: true, output: `fallback:${call.name}`,
            }),
          },
        })
        return {
          turns,
          execute: () => {
            if (!execute) throw new Error('turn executor expected')
            return execute
          },
        }
      }

      const first = compose(runtime(f))
      const firstTurn = await first.turns.acquire(
        () => async () => ({ decision: 'rejected' }),
      )
      const imported = await first.execute()({
        name: 'import_attachment',
        args: { fileId: 'upload-1', destination: 'project-file' },
      })
      expect(imported.ok).toBe(true)
      expect(imported.output).not.toContain('../../hostile.bin')
      expect(JSON.parse(imported.output)).toEqual({
        relativePath: 'imports/upload-1',
        sha256: payloadHash,
        sizeBytes: payload.byteLength,
        provenance: 'untrusted',
        published: true,
      })
      await expect(first.execute()({
        name: 'read_file', args: { path: 'imports/upload-1' },
      })).resolves.toEqual({ ok: true, output: payload.toString('utf8') })
      await firstTurn.release?.()

      const restarted = compose(runtime(f))
      const restartedTurn = await restarted.turns.acquire(
        () => async () => ({ decision: 'rejected' }),
      )
      await expect(restarted.execute()({
        name: 'import_attachment',
        args: { fileId: 'upload-1', destination: 'project-file' },
      })).resolves.toEqual(imported)
      await expect(restarted.execute()({
        name: 'read_file', args: { path: 'imports/upload-1' },
      })).resolves.toEqual({ ok: true, output: payload.toString('utf8') })
      await restartedTurn.release?.()
    }, 15_000)

    it.each([
      'after-create-wal',
      'after-stage',
      'after-pending-manifest',
      'after-advance-wal',
      'after-install',
      'after-publish-manifest',
      'after-audit',
      'after-delete-wal',
    ] as const)('recovers after a real durable side effect: %s', async (fault) => {
      const f = fixture()
      let injected = false
      const faultAtStore = (point: AttachmentImportStoreFault): void => {
        if (!injected && point === fault) {
          injected = true
          throw new Error(`crash:${fault}`)
        }
      }
      const faultAtFile = (point: 'after-stage' | 'after-install'): void => {
        if (!injected && point === fault) {
          injected = true
          throw new Error(`crash:${fault}`)
        }
      }
      const crashing = runtime(f, { faultAtStore, faultAtFile })
      await expect(crashing.service.importAttachment(f.lease, 'upload-1', 'project-file'))
        .rejects.toThrow(`crash:${fault}`)

      const recovered = await runtime(f).service.importAttachment(
        f.lease,
        'upload-1',
        'project-file',
      )
      expect(recovered.published).toBe(true)
      expect(readFileSync(join(f.projectRoot, 'imports', 'upload-1'))).toEqual(f.payload)
    }, 15_000)

    it('rejects a foreign inbox binding before attachment byte I/O', async () => {
      const f = fixture('session-foreign')
      const operations: string[] = []
      const delegate = makeNodeAttachmentWorkerProcessPort({ pythonExecutable, workerPath })
      const process: AttachmentWorkerProcessPort = {
        run(request) {
          operations.push(request.op)
          return delegate.run(request)
        },
      }

      await expect(runtime(f, { process }).service.importAttachment(
        f.lease,
        'upload-1',
        'project-file',
      )).rejects.toEqual(expect.objectContaining<Partial<AttachmentImportError>>({
        code: 'BINDING_MISMATCH',
      }))
      expect(operations).toEqual(['read-record'])
    }, 15_000)

    it('does not overwrite an existing destination with different bytes', async () => {
      const f = fixture()
      mkdirSync(join(f.projectRoot, 'imports'))
      writeFileSync(join(f.projectRoot, 'imports', 'upload-1'), 'pre-existing')

      await expect(runtime(f).service.importAttachment(
        f.lease,
        'upload-1',
        'project-file',
      )).rejects.toEqual(expect.objectContaining<Partial<AttachmentImportError>>({
        code: 'COLLISION',
      }))
      expect(readFileSync(join(f.projectRoot, 'imports', 'upload-1'), 'utf8'))
        .toBe('pre-existing')
    }, 15_000)

    it('hides installed-but-unpublished files and verifies published bytes on every read/list', async () => {
      const f = fixture()
      const payload = Buffer.from('published text', 'utf8')
      const sha256 = createHash('sha256').update(payload).digest('hex')
      writeFileSync(join(f.inboxRoot, 'objects', 'upload-1'), payload)
      const recordPath = join(f.inboxRoot, 'records', 'upload-1.json')
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, unknown>
      writeFileSync(recordPath, JSON.stringify({
        ...record,
        sha256,
        sizeBytes: payload.byteLength,
      }))
      let crashed = false
      const attachment = runtime(f, {
        faultAtFile: (point) => {
          if (!crashed && point === 'after-install') {
            crashed = true
            throw new Error('crash:after-install')
          }
        },
      })
      await expect(attachment.service.importAttachment(f.lease, 'upload-1', 'project-file'))
        .rejects.toThrow('crash:after-install')
      let id = 0
      const confinement = attachment.wrapConfinement(makeConfinementPort({
        leases: f.projectRuntime.leases,
        process: makeNodeConfinementProcessPort({
          pythonExecutable,
          workerPath: confinementWorkerPath,
        }),
        newId: () => `visibility-${++id}`,
      }))

      await expect(confinement.list(f.lease, 'imports')).resolves.toEqual([])
      await expect(confinement.readText(f.lease, 'imports/upload-1')).rejects.toEqual(
        new ConfinementError('NOT_FOUND'),
      )
      await runtime(f).service.importAttachment(f.lease, 'upload-1', 'project-file')
      await expect(confinement.list(f.lease, 'imports')).resolves.toEqual(['upload-1'])
      await expect(confinement.readText(f.lease, 'imports/upload-1')).resolves
        .toBe('published text')
      await expect(confinement.writeText(f.lease, 'imports/upload-1', 'overwrite'))
        .rejects.toEqual(new ConfinementError('INVALID_PATH'))
      await expect(confinement.editText(
        f.lease,
        'imports/upload-1',
        'published',
        'overwritten',
      )).rejects.toEqual(new ConfinementError('INVALID_PATH'))
      await expect(confinement.scan(f.lease)).rejects.toEqual(
        new ConfinementError('INVALID_PATH'),
      )

      writeFileSync(join(f.projectRoot, 'imports', 'upload-1'), 'tampered')
      await expect(confinement.readText(f.lease, 'imports/upload-1')).rejects.toEqual(
        new ConfinementError('PATH_CHANGED'),
      )
      await expect(confinement.list(f.lease, 'imports')).rejects.toEqual(
        new ConfinementError('PATH_CHANGED'),
      )
    }, 15_000)
  },
)

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeContextLeaseCoordinator,
  type AgentRunner,
  type AttachmentImportService,
  type ConfinementPort,
  type ProjectService,
  type ScopedMemoryRouter,
  type ToolCall,
  type ToolResult,
  type TurnContextLease,
} from '@aisy/core'
import { describe, expect, it } from 'vitest'
import type { NodeAttachmentImportRuntime } from './attachment-import-runtime.js'
import type { LeaseBoundDockerBashPolicy } from './lease-bound-docker-bash.js'
import { makeNodeProjectToolsInteractiveTurnRuntimeFactory } from './project-service-runtime.js'

const IMAGE = `registry.example/aisy/bash@sha256:${'a'.repeat(64)}`
const POLICY: LeaseBoundDockerBashPolicy = {
  imageDigest: IMAGE,
  runtime: 'runsc',
  memoryBytes: 256 * 1024 * 1024,
  cpuMillicores: 500,
  pids: 64,
  wallTimeMs: 10_000,
  maxOutputBytes: 128 * 1024,
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { name, args }
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function writeFakeDocker(input: {
  directory: string
  root: string
  command: string
}): { executable: string; callsPath: string } {
  const executable = join(input.directory, 'docker')
  const callsPath = join(input.directory, 'calls.log')
  const inspect = JSON.stringify({
    Config: { Image: IMAGE, User: '65532:65532', Cmd: ['sh', '-lc', input.command] },
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false,
      IpcMode: 'none', PidMode: '', UTSMode: '', CgroupnsMode: 'private',
      PidsLimit: POLICY.pids, Memory: POLICY.memoryBytes,
      MemorySwap: POLICY.memoryBytes, NanoCpus: POLICY.cpuMillicores * 1_000_000,
      Runtime: POLICY.runtime, CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges=true', 'seccomp=builtin'], Devices: [],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,mode=0700' },
      LogConfig: {
        Type: 'local',
        Config: {
          'max-size': String(POLICY.maxOutputBytes), 'max-file': '1', compress: 'false',
        },
      },
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    },
    Mounts: [{ Type: 'bind', Source: input.root, Destination: '/work', RW: true }],
    State: {
      Status: 'exited', Running: false, Dead: false, OOMKilled: false,
      ExitCode: 0, Error: '',
    },
  })
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${shellLiteral(callsPath)}
case "$1:$2" in
  info:*) printf '%s\\n' '["name=userns"]' ;;
  container:create) ;;
  container:inspect) printf '%s\\n' ${shellLiteral(inspect)} ;;
  container:start) ;;
  container:wait) printf '0\\n' ;;
  container:logs) printf 'sandboxed\\n' ;;
  container:rm) ;;
  *) exit 97 ;;
esac
`
  writeFileSync(executable, script, { mode: 0o700 })
  chmodSync(executable, 0o700)
  return { executable, callsPath }
}

describe('production-preview Project tools composition', () => {
  it('binds attachments and Docker bash to one exact turn lease without composition I/O', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-project-tools-')))
    try {
      const projectRoot = realpathSync(mkdtempSync(join(directory, 'project-')))
      const command = 'pwd'
      const fakeDocker = writeFakeDocker({ directory, root: projectRoot, command })
      let id = 0
      const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++id}` })
      const acquired: TurnContextLease[] = []
      const service = {
        acquireTurnContext: () => {
          const lease = leases.acquire({
            operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
            projectKind: 'project', sessionId: 'session-a', root: projectRoot, generation: 7,
          })
          acquired.push(lease)
          return lease
        },
        releaseTurnContext: (lease: TurnContextLease) => leases.quiesceAndClose(lease),
      } as unknown as ProjectService
      const fileReads: Array<{ lease: TurnContextLease; path: string }> = []
      const confinement: ConfinementPort = {
        readText: async (lease, path) => {
          fileReads.push({ lease, path })
          return `read:${path}`
        },
        writeText: async (_lease, _path, text) => Buffer.byteLength(text),
        editText: async () => ({ bytes: 0, replacements: 1 }),
        list: async () => [],
        scan: async () => ({ entries: 0, files: 0, directories: 0, totalBytes: 0 }),
      }
      const imports: Array<{ lease: TurnContextLease; fileId: string }> = []
      const attachmentService: AttachmentImportService = {
        importAttachment: async (lease, fileId) => {
          imports.push({ lease, fileId })
          return {
            schemaVersion: 1, operationId: 'import-1', fileId,
            operatorId: lease.operatorId, profileId: lease.profileId,
            projectId: lease.projectId, sessionId: lease.sessionId,
            source: 'telegram', originalName: 'proof.txt', relativePath: 'files/proof.txt',
            sha256: 'b'.repeat(64), sizeBytes: 5, provenance: 'untrusted',
            provenanceRef: 'telegram:file-1', createdAt: '2026-07-27T00:00:00.000Z',
            importedFromFileId: fileId, published: true,
          }
        },
      }
      const attachments = {
        service: attachmentService,
        wrapConfinement: (delegate: ConfinementPort) => delegate,
      } satisfies Pick<NodeAttachmentImportRuntime, 'service' | 'wrapConfinement'>
      let executeTool: ((call: ToolCall) => Promise<ToolResult>) | undefined
      const runner: AgentRunner = {
        handle: async () => ({ state: 'ok', reply: 'ok', narrowed: false }),
      }
      const factory = makeNodeProjectToolsInteractiveTurnRuntimeFactory({
        runtime: { service, leases, confinement },
        attachments,
        bash: { dockerExecutable: fakeDocker.executable, policy: POLICY },
        deps: {
          owner: { operatorId: 'telegram:42', profileId: 'default' },
          scopedMemory: {} as ScopedMemoryRouter,
          buildRunner: input => {
            executeTool = input.executeTool
            return runner
          },
          executeNonContextTool: async () => ({ ok: false, output: 'unsupported' }),
        },
      })

      expect(existsSync(fakeDocker.callsPath)).toBe(false)
      const runtime = await factory.acquire(() => async () => ({ decision: 'confirmed' }))
      expect(existsSync(fakeDocker.callsPath)).toBe(false)

      await expect(executeTool!(call('bash', { cmd: command }))).resolves.toEqual({
        ok: true, output: 'sandboxed\n\n(exit 0)',
      })
      await expect(executeTool!(call('read_file', { path: 'proof.txt' }))).resolves.toEqual({
        ok: true, output: 'read:proof.txt',
      })
      await expect(executeTool!(call('import_attachment', {
        fileId: 'file-1', destination: 'project-file',
      }))).resolves.toMatchObject({ ok: true })
      expect(imports).toEqual([{ lease: acquired[0], fileId: 'file-1' }])
      expect(fileReads).toEqual([{ lease: acquired[0], path: 'proof.txt' }])

      const callsBeforeClose = readFileSync(fakeDocker.callsPath, 'utf8').trim().split('\n')
      expect(callsBeforeClose.map(line => line.split(' ').slice(0, 2).join(' '))).toEqual([
        'info --format={{json', 'container create', 'container inspect',
        'container start', 'container wait', 'container inspect',
        'container logs', 'container rm',
      ])
      await runtime.release?.()
      await expect(executeTool!(call('bash', { cmd: command }))).resolves.toEqual({
        ok: false, output: 'bash: STALE_CONTEXT',
      })
      expect(readFileSync(fakeDocker.callsPath, 'utf8').trim().split('\n')).toHaveLength(8)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeContextLeaseCoordinator,
  type ContextLeaseCoordinator,
  type TurnContextLease,
} from '@aisy/core'
import {
  leaseBoundDockerBashArgv,
  inspectNodeLeaseBoundDockerBashRoot,
  LeaseBoundDockerBashError,
  makeLeaseBoundDockerBash,
  type LeaseBoundDockerBashEvent,
  type LeaseBoundDockerBashPolicy,
} from './lease-bound-docker-bash.js'
import type {
  DockerCommandPort,
  DockerCommandResult,
} from './restricted-clone-docker-supervisor.js'

const IMAGE = `registry.example:5443/aisy/bash@sha256:${'a'.repeat(64)}`
const POLICY: LeaseBoundDockerBashPolicy = {
  imageDigest: IMAGE,
  runtime: 'runsc',
  memoryBytes: 512 * 1024 * 1024,
  cpuMillicores: 1_000,
  pids: 128,
  wallTimeMs: 30_000,
  maxOutputBytes: 1024 * 1024,
}

function fixture(): { leases: ContextLeaseCoordinator; lease: TurnContextLease } {
  let id = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-op-${++id}` })
  const lease = leases.acquire({
    operatorId: 'telegram:42',
    profileId: 'default',
    projectId: 'project-a',
    projectKind: 'project',
    sessionId: 'session-a',
    root: '/srv/aisy/projects/project-a',
    generation: 7,
  })
  return { leases, lease }
}

function option(args: readonly string[], name: string): string {
  const value = args.find(item => item.startsWith(`${name}=`))
  if (value === undefined) throw new Error(`missing ${name}`)
  return value.slice(name.length + 1)
}

function inspectFixture(input: {
  argv: ReturnType<typeof leaseBoundDockerBashArgv>
  lease: TurnContextLease
  command: string
  state: Record<string, unknown>
}): Record<string, unknown> {
  return {
    Config: {
      Image: POLICY.imageDigest,
      User: '65532:65532',
      Cmd: ['sh', '-lc', input.command],
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      IpcMode: 'none',
      PidMode: '',
      UTSMode: '',
      CgroupnsMode: 'private',
      PidsLimit: POLICY.pids,
      Memory: POLICY.memoryBytes,
      MemorySwap: POLICY.memoryBytes,
      NanoCpus: POLICY.cpuMillicores * 1_000_000,
      Runtime: POLICY.runtime,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges=true', 'seccomp=builtin'],
      Devices: [],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,mode=0700' },
      LogConfig: {
        Type: 'local',
        Config: {
          'max-size': String(POLICY.maxOutputBytes),
          'max-file': '1',
          compress: 'false',
        },
      },
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    },
    Mounts: [{
      Type: 'bind',
      Source: input.lease.root,
      Destination: '/work',
      RW: true,
    }],
    State: input.state,
  }
}

function ok(stdout = ''): DockerCommandResult {
  return { exitCode: 0, stdout, stderr: '' }
}

function dockerFake(input: {
  leases: ContextLeaseCoordinator
  lease: TurnContextLease
  command: string
  security?: readonly string[]
  mutateInspect?: (value: Record<string, unknown>) => void
  startResult?: DockerCommandResult
  startTransportResult?: DockerCommandResult
  waitResult?: DockerCommandResult
  logsResult?: DockerCommandResult
  cleanupResult?: DockerCommandResult
  finalState?: Record<string, unknown>
  onStart?: () => void
}): { docker: DockerCommandPort; calls: string[][] } {
  const argv = leaseBoundDockerBashArgv({
    lease: input.lease,
    operationId: 'lease-op-2',
    command: input.command,
    policy: POLICY,
  })
  const calls: string[][] = []
  let inspects = 0
  const docker: DockerCommandPort = {
    async run(args): Promise<DockerCommandResult> {
      const call = [...args]
      calls.push(call)
      if (call[0] === 'info') {
        return ok(JSON.stringify(input.security ?? ['name=seccomp,profile=builtin', 'name=userns']))
      }
      if (call[0] === 'container' && call[1] === 'create') return ok(`${argv.name}\n`)
      if (call[0] === 'container' && call[1] === 'inspect') {
        inspects += 1
        const value = inspectFixture({
          argv,
          lease: input.lease,
          command: input.command,
          state: inspects === 1
            ? { Status: 'created', Running: false, Dead: false, OOMKilled: false, ExitCode: 0, Error: '' }
            : input.finalState ?? {
                Status: 'exited', Running: false, Dead: false, OOMKilled: false,
                ExitCode: input.startResult?.exitCode ?? 0, Error: '',
              },
        })
        input.mutateInspect?.(value)
        return ok(JSON.stringify(value))
      }
      if (call[0] === 'container' && call[1] === 'start') {
        input.onStart?.()
        return input.startTransportResult ?? ok()
      }
      if (call[0] === 'container' && call[1] === 'wait') {
        if (input.waitResult !== undefined) return input.waitResult
        if (input.startResult?.aborted === true || input.startResult?.timedOut === true ||
          input.startResult?.overflow === true) return input.startResult
        return ok(`${input.startResult?.exitCode ?? 0}\n`)
      }
      if (call[0] === 'container' && call[1] === 'logs') {
        return input.logsResult ?? {
          exitCode: 0,
          stdout: input.startResult?.stdout ?? 'done\n',
          stderr: input.startResult?.stderr ?? '',
        }
      }
      if (call[0] === 'container' && call[1] === 'rm') {
        return input.cleanupResult ?? ok()
      }
      throw new Error(`unexpected Docker call: ${call.join(' ')}`)
    },
  }
  return { docker, calls }
}

describe('lease-bound one-shot Docker bash', () => {
  it('pins a real directory identity and rejects a symlink root', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-bash-root-')))
    const link = `${root}-link`
    try {
      symlinkSync(root, link, 'dir')
      expect(inspectNodeLeaseBoundDockerBashRoot(root)).toMatchObject({
        canonicalRoot: root,
      })
      expect(() => inspectNodeLeaseBoundDockerBashRoot(link)).toThrowError(
        expect.objectContaining({ code: 'BASH_ROOT_CHANGED' }),
      )
    } finally {
      unlinkSync(link)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds a pinned, no-network, non-root exact-lease-root container policy', () => {
    const { lease } = fixture()
    const command = 'printf "%s" "$PWD"'
    const argv = leaseBoundDockerBashArgv({
      lease,
      operationId: 'operation-a',
      command,
      policy: POLICY,
    })

    expect(argv.create).toEqual(expect.arrayContaining([
      '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges=true', '--security-opt=seccomp=builtin',
      '--ipc=none', '--user=65532:65532', '--runtime=runsc', '--log-driver=local',
      `--mount=type=bind,src=${lease.root},dst=/work,rw`,
    ]))
    expect(argv.create.at(-4)).toBe(IMAGE)
    expect(argv.create.slice(-3)).toEqual(['sh', '-lc', command])
    expect(option(argv.create, '--memory')).toBe(String(POLICY.memoryBytes))
    expect(option(argv.create, '--memory-swap')).toBe(String(POLICY.memoryBytes))
    expect(option(argv.create, '--pids-limit')).toBe(String(POLICY.pids))
    expect(argv.create.some(value => value.startsWith('--userns-remap') ||
      value === '--userns=host' || value === '--privileged' ||
      value.startsWith('--publish') || value.includes('docker.sock'))).toBe(false)
    expect(JSON.stringify(argv)).not.toMatch(/TOKEN|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK/)
  })

  it('probes daemon isolation, verifies inspect before start and cleans up after success', async () => {
    const { leases, lease } = fixture()
    const events: LeaseBoundDockerBashEvent[] = []
    const fake = dockerFake({ leases, lease, command: 'echo done' })
    let rootChecks = 0
    const bash = makeLeaseBoundDockerBash({
      leases,
      docker: fake.docker,
      policy: POLICY,
      inspectRoot: root => {
        rootChecks += 1
        return { canonicalRoot: root, identity: 'device-1:inode-2' }
      },
      emit: event => events.push(event),
    })

    await expect(bash(lease, 'echo done')).resolves.toEqual({
      stdout: 'done\n', stderr: '', exitCode: 0,
    })
    expect(fake.calls.map(call => call.slice(0, 2))).toEqual([
      ['info', '--format={{json .SecurityOptions}}'],
      ['container', 'create'],
      ['container', 'inspect'],
      ['container', 'start'],
      ['container', 'wait'],
      ['container', 'inspect'],
      ['container', 'logs'],
      ['container', 'rm'],
    ])
    expect(rootChecks).toBe(2)
    expect(events.map(event => event.kind)).toEqual([
      'sandbox.bash.started', 'sandbox.bash.completed',
    ])
    expect(JSON.stringify(events)).not.toContain('echo done')
  })

  it('fails before create when daemon user namespace isolation is absent', async () => {
    const { leases, lease } = fixture()
    const fake = dockerFake({
      leases,
      lease,
      command: 'true',
      security: ['name=seccomp,profile=builtin', 'name=cgroupns'],
    })
    const bash = makeLeaseBoundDockerBash({
      leases,
      docker: fake.docker,
      policy: POLICY,
      inspectRoot: root => ({ canonicalRoot: root, identity: 'stable' }),
    })

    await expect(bash(lease, 'true')).rejects.toEqual(
      new LeaseBoundDockerBashError('BASH_USERNS_REQUIRED'),
    )
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]![0]).toBe('info')
  })

  it('denies weakened inspect before command execution and removes its container', async () => {
    const { leases, lease } = fixture()
    const fake = dockerFake({
      leases,
      lease,
      command: 'private command',
      mutateInspect: value => {
        (value.HostConfig as Record<string, unknown>).NetworkMode = 'bridge'
      },
    })
    const bash = makeLeaseBoundDockerBash({
      leases,
      docker: fake.docker,
      policy: POLICY,
      inspectRoot: root => ({ canonicalRoot: root, identity: 'stable' }),
    })

    await expect(bash(lease, 'private command')).rejects.toEqual(
      new LeaseBoundDockerBashError('BASH_INSPECT_DENIED'),
    )
    expect(fake.calls.some(call => call[0] === 'container' && call[1] === 'start')).toBe(false)
    expect(fake.calls.at(-1)?.slice(0, 3)).toEqual(['container', 'rm', '--force'])
  })

  it('detects root identity replacement after create and never starts the command', async () => {
    const { leases, lease } = fixture()
    const fake = dockerFake({ leases, lease, command: 'true' })
    let rootChecks = 0
    const bash = makeLeaseBoundDockerBash({
      leases,
      docker: fake.docker,
      policy: POLICY,
      inspectRoot: root => ({
        canonicalRoot: root,
        identity: ++rootChecks === 1 ? 'device-1:inode-2' : 'device-1:inode-3',
      }),
    })

    await expect(bash(lease, 'true')).rejects.toEqual(
      new LeaseBoundDockerBashError('BASH_ROOT_CHANGED'),
    )
    expect(fake.calls.some(call => call[1] === 'start')).toBe(false)
    expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(['container', 'rm'])
  })

  it('cancels a running command on switch, cleans up and lets the lease drain', async () => {
    const { leases, lease } = fixture()
    let closing: Promise<void> | undefined
    const fake = dockerFake({
      leases,
      lease,
      command: 'sleep 999',
      startResult: { exitCode: 1, stdout: '', stderr: '', aborted: true },
      onStart: () => { closing = leases.quiesceAndClose(lease) },
    })
    const bash = makeLeaseBoundDockerBash({
      leases,
      docker: fake.docker,
      policy: POLICY,
      inspectRoot: root => ({ canonicalRoot: root, identity: 'stable' }),
    })

    await expect(bash(lease, 'sleep 999')).rejects.toEqual(
      new LeaseBoundDockerBashError('BASH_ABORTED'),
    )
    await expect(closing).resolves.toBeUndefined()
    expect(leases.status(lease)).toBe('closed')
    expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(['container', 'rm'])
  })

  it('reports cleanup failure as fail-closed and never leaks Docker stderr', async () => {
    const { leases, lease } = fixture()
    const fake = dockerFake({
      leases,
      lease,
      command: 'echo ok',
      cleanupResult: {
        exitCode: 1,
        stdout: '',
        stderr: `cannot remove ${lease.root}/private-token`,
      },
    })
    const bash = makeLeaseBoundDockerBash({
      leases,
      docker: fake.docker,
      policy: POLICY,
      inspectRoot: root => ({ canonicalRoot: root, identity: 'stable' }),
    })

    const result = bash(lease, 'echo ok')
    await expect(result).rejects.toEqual(
      new LeaseBoundDockerBashError('BASH_CLEANUP_FAILED'),
    )
    await expect(result).rejects.not.toThrow(/private-token/)
    expect(leases.status(lease)).toBe('active')
  })

  it('withholds Docker infrastructure stderr when final state does not attest execution', async () => {
    const { leases, lease } = fixture()
    const fake = dockerFake({
      leases,
      lease,
      command: 'echo expected',
      startResult: {
        exitCode: 1,
        stdout: '',
        stderr: `daemon disconnected at ${lease.root}/private-token`,
      },
      finalState: {
        Status: 'created', Running: false, Dead: false, OOMKilled: false,
        ExitCode: 0, Error: '',
      },
    })
    const bash = makeLeaseBoundDockerBash({
      leases,
      docker: fake.docker,
      policy: POLICY,
      inspectRoot: root => ({ canonicalRoot: root, identity: 'stable' }),
    })

    const result = bash(lease, 'echo expected')
    await expect(result).rejects.toEqual(
      new LeaseBoundDockerBashError('BASH_EXECUTION_FAILED'),
    )
    await expect(result).rejects.not.toThrow(/private-token/)
    expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(['container', 'rm'])
  })

  it('never confuses a colliding docker start failure with the command exit code', async () => {
    const { leases, lease } = fixture()
    const fake = dockerFake({
      leases,
      lease,
      command: 'exit 1',
      startResult: { exitCode: 1, stdout: '', stderr: 'expected command error' },
      startTransportResult: {
        exitCode: 1,
        stdout: '',
        stderr: `daemon disconnected at ${lease.root}/private-token`,
      },
      finalState: {
        Status: 'exited', Running: false, Dead: false, OOMKilled: false,
        ExitCode: 1, Error: '',
      },
    })
    const bash = makeLeaseBoundDockerBash({
      leases,
      docker: fake.docker,
      policy: POLICY,
      inspectRoot: root => ({ canonicalRoot: root, identity: 'stable' }),
    })

    const result = bash(lease, 'exit 1')
    await expect(result).rejects.toEqual(
      new LeaseBoundDockerBashError('BASH_EXECUTION_FAILED'),
    )
    await expect(result).rejects.not.toThrow(/private-token/)
    expect(fake.calls.some(call => call[1] === 'wait')).toBe(false)
    expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(['container', 'rm'])
  })

  it('returns an attested non-zero shell exit and maps OOM to a code-only error', async () => {
    const first = fixture()
    const failedCommand = dockerFake({
      leases: first.leases,
      lease: first.lease,
      command: 'exit 2',
      startResult: { exitCode: 2, stdout: '', stderr: 'expected failure' },
    })
    const bash = makeLeaseBoundDockerBash({
      leases: first.leases,
      docker: failedCommand.docker,
      policy: POLICY,
      inspectRoot: root => ({ canonicalRoot: root, identity: 'stable' }),
    })
    await expect(bash(first.lease, 'exit 2')).resolves.toEqual({
      stdout: '', stderr: 'expected failure', exitCode: 2,
    })

    const second = fixture()
    const oom = dockerFake({
      leases: second.leases,
      lease: second.lease,
      command: 'allocate',
      startResult: { exitCode: 137, stdout: '', stderr: 'killed' },
      finalState: {
        Status: 'exited', Running: false, Dead: false, OOMKilled: true,
        ExitCode: 137, Error: '',
      },
    })
    const oomBash = makeLeaseBoundDockerBash({
      leases: second.leases,
      docker: oom.docker,
      policy: POLICY,
      inspectRoot: root => ({ canonicalRoot: root, identity: 'stable' }),
    })
    await expect(oomBash(second.lease, 'allocate')).rejects.toEqual(
      new LeaseBoundDockerBashError('BASH_RESOURCE_LIMIT'),
    )
  })

  it('rejects a closed lease before any Docker I/O', async () => {
    const { leases, lease } = fixture()
    await leases.quiesceAndClose(lease)
    const calls: string[][] = []
    const bash = makeLeaseBoundDockerBash({
      leases,
      docker: { async run(args) { calls.push([...args]); return ok() } },
      policy: POLICY,
      inspectRoot: root => ({ canonicalRoot: root, identity: 'stable' }),
    })

    await expect(bash(lease, 'true')).rejects.toMatchObject({ code: 'STALE_CONTEXT' })
    expect(calls).toEqual([])
  })
})

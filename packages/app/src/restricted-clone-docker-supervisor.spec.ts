import { describe, expect, it, vi } from 'vitest'
import type { RestrictedCloneTarget } from '@aisy/core'
import {
  makeRestrictedCloneDockerSupervisor,
  restrictedCloneDockerArgv,
  restrictedCloneDockerNames,
  RestrictedCloneDockerSupervisorError,
  type DockerCommandPort,
  type DockerCommandResult,
} from './restricted-clone-docker-supervisor.js'
import {
  makeRestrictedCloneSidecarTransport,
  type RestrictedCloneSidecarAttestation,
  type RestrictedCloneSidecarRequest,
} from './restricted-clone-sidecar.js'

const PROJECTS_ROOT = '/srv/aisy/projects'
const STAGING_ROOT = `${PROJECTS_ROOT}/.aisy-staging-docker-1`
const WORKER_IMAGE = `registry.example/aisy/clone@sha256:${'a'.repeat(64)}`
const GATEWAY_IMAGE = `registry.example/aisy/egress@sha256:${'b'.repeat(64)}`

function target(): RestrictedCloneTarget {
  return {
    url: 'https://git.example.org/team/repo.git',
    hostname: 'git.example.org',
    port: 443,
    addresses: [
      { address: '93.184.216.34', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ],
    transportPolicy: {
      connectOnlyToReviewedAddresses: true,
      preserveTlsServerName: true,
      followRedirects: false,
    },
  }
}

function attestation(request: RestrictedCloneSidecarRequest): RestrictedCloneSidecarAttestation {
  return {
    protocolVersion: 1,
    executionId: request.executionId,
    policyHash: request.policyHash,
    imageDigest: request.imageDigest,
    stagingIdentity: request.staging.identity,
    outcome: 'succeeded',
    exitCode: 0,
    outputBytes: 0,
    sandboxDestroyed: true,
    applied: {
      network: 'isolated-egress-gateway-only',
      credentials: 'none',
      hostNetwork: false,
      dockerSocket: false,
      privileged: false,
    },
  }
}

async function requestFixture(): Promise<RestrictedCloneSidecarRequest> {
  let captured: RestrictedCloneSidecarRequest | undefined
  const transport = makeRestrictedCloneSidecarTransport({
    projectsRoot: PROJECTS_ROOT,
    imageDigest: WORKER_IMAGE,
    supervisor: {
      async run(request) {
        captured = request
        return attestation(request)
      },
    },
    newId: () => 'clone-docker-1',
    inspectStaging: path => ({ canonicalRoot: path, identity: 'device-1:inode-2' }),
  })
  await transport.clone({ target: target(), stagingRoot: STAGING_ROOT })
  if (captured === undefined) throw new Error('request not captured')
  return captured
}

function option(args: readonly string[], name: string): string {
  const value = args.find(arg => arg.startsWith(`${name}=`))
  if (value === undefined) throw new Error(`missing ${name}`)
  return value.slice(name.length + 1)
}

function inspectFromCreate(
  create: readonly string[],
  networkMode: string,
  networks: readonly string[],
  state: { running: boolean; exitCode: number; oomKilled: boolean } = {
    running: true,
    exitCode: 0,
    oomKilled: false,
  },
): Record<string, unknown> {
  const tmpfs = Object.fromEntries(
    create.filter(arg => arg.startsWith('--tmpfs='))
      .map(arg => arg.slice('--tmpfs='.length).split(/:(.*)/s).slice(0, 2)),
  )
  return {
    Config: {
      Image: create.at(-1),
      User: option(create, '--user'),
      Env: create.filter(arg => arg.startsWith('--env=')).map(arg => arg.slice('--env='.length)),
      Labels: Object.fromEntries(create.filter(arg => arg.startsWith('--label='))
        .map(arg => arg.slice('--label='.length).split(/=(.*)/s).slice(0, 2))),
    },
    HostConfig: {
      NetworkMode: networkMode,
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges=true', 'seccomp=builtin'],
      IpcMode: 'none',
      Memory: Number(option(create, '--memory')),
      MemorySwap: Number(option(create, '--memory-swap')),
      NanoCpus: Number(option(create, '--cpus')) * 1_000_000_000,
      PidsLimit: Number(option(create, '--pids-limit')),
      Binds: null,
      Tmpfs: tmpfs,
    },
    Mounts: [],
    NetworkSettings: { Networks: Object.fromEntries(networks.map(name => [name, {}])) },
    State: { Running: state.running, ExitCode: state.exitCode, OOMKilled: state.oomKilled },
  }
}

function ok(stdout = ''): DockerCommandResult {
  return { exitCode: 0, stdout, stderr: '' }
}

function dockerFake(input: {
  request: RestrictedCloneSidecarRequest
  mutateInspect?: (name: 'gateway' | 'worker', value: Record<string, unknown>) => void
  workerStatus?: DockerCommandResult
  workerStopped?: { exitCode: number; oomKilled: boolean }
  dockerVersion?: string
  failCleanup?: boolean
  afterCopy?: () => void
  afterWorkerStatus?: () => void
}): { docker: DockerCommandPort; calls: string[][]; signals: Array<AbortSignal | undefined> } {
  const argv = restrictedCloneDockerArgv({ request: input.request, gatewayImageDigest: GATEWAY_IMAGE })
  const names = restrictedCloneDockerNames(input.request)
  const calls: string[][] = []
  const signals: Array<AbortSignal | undefined> = []
  let gatewayInspects = 0
  let workerInspects = 0
  const docker: DockerCommandPort = {
    async run(args, options): Promise<DockerCommandResult> {
      const command = [...args]
      calls.push(command)
      signals.push(options.signal)
      if (command[0] === 'version') return ok(`${input.dockerVersion ?? '29.6.0'}\n`)
      if (command[0] === 'container' && command[1] === 'inspect') {
        const name = command.at(-1)
        if (name === names.gateway) {
          gatewayInspects += 1
          const value = inspectFromCreate(
            argv.gatewayCreate,
            'bridge',
            gatewayInspects === 1 ? ['bridge'] : ['bridge', names.network],
          )
          input.mutateInspect?.('gateway', value)
          return ok(JSON.stringify(value))
        }
        workerInspects += 1
        const stopped = workerInspects > 1 && input.workerStopped !== undefined
        const value = inspectFromCreate(
          argv.workerCreate,
          names.network,
          [names.network],
          stopped
            ? { running: false, exitCode: input.workerStopped!.exitCode, oomKilled: input.workerStopped!.oomKilled }
            : { running: true, exitCode: 0, oomKilled: false },
        )
        input.mutateInspect?.('worker', value)
        return ok(JSON.stringify(value))
      }
      if (command[0] === 'container' && command[1] === 'exec' && command[2] === names.worker) {
        input.afterWorkerStatus?.()
        return input.workerStatus ?? ok()
      }
      if (command[0] === 'container' && command[1] === 'cp') input.afterCopy?.()
      if (input.failCleanup === true && command[0] === 'container' && command[1] === 'rm') {
        return { exitCode: 1, stdout: '', stderr: '' }
      }
      return ok()
    },
  }
  return { docker, calls, signals }
}

describe('restricted clone Docker supervisor', () => {
  it('builds a no-shell, no-mount, exact-egress one-shot command policy', async () => {
    const request = await requestFixture()
    const argv = restrictedCloneDockerArgv({ request, gatewayImageDigest: GATEWAY_IMAGE })

    expect(argv.networkCreate).toEqual(expect.arrayContaining(['--driver=ipvlan', '--internal']))
    expect(argv.gatewayCreate).toContain('--network=name=bridge,gw-priority=1')
    expect(argv.gatewayConnect).toContain('--alias=egress')
    expect(argv.workerCreate).toContain(`--network=${restrictedCloneDockerNames(request).network}`)
    for (const command of [argv.gatewayCreate, argv.workerCreate]) {
      expect(command).toEqual(expect.arrayContaining([
        '--pull=never', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges=true', '--security-opt=seccomp=builtin',
        '--ipc=none', '--user=65532:65532',
      ]))
      expect(command.some(arg => arg === '--privileged' || arg.startsWith('--publish') ||
        arg.startsWith('--volume') || arg.startsWith('--mount') || arg.includes('docker.sock'))).toBe(false)
    }
    expect(argv.gatewayCreate).toContain(
      '--env=AISY_EGRESS_IPS_JSON=["93.184.216.34","2001:4860:4860::8888"]',
    )
    expect(argv.workerCreate).toContain(`--env=AISY_CLONE_URL=${request.target.url}`)
    expect(argv.workerCreate).toContain(
      `--tmpfs=/workspace:rw,nosuid,nodev,noexec,size=${request.sandbox.limits.diskBytes},mode=0700`,
    )
    expect(JSON.stringify(argv)).not.toMatch(/TOKEN|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK/)
  })

  it('exports only after verified policy and destroys worker, gateway, then network', async () => {
    const request = await requestFixture()
    let staging: string[] = []
    const fake = dockerFake({ request, afterCopy: () => { staging = ['.git', 'README.md'] } })
    const supervisor = makeRestrictedCloneDockerSupervisor({
      docker: fake.docker,
      gatewayImageDigest: GATEWAY_IMAGE,
      listStaging: () => staging,
      sleep: async () => {},
    })

    const result = await supervisor.run(request)

    expect(result).toMatchObject({ outcome: 'succeeded', exitCode: 0, sandboxDestroyed: true })
    const names = restrictedCloneDockerNames(request)
    expect(fake.calls.slice(-3)).toEqual([
      ['container', 'rm', '--force', '--volumes', names.worker],
      ['container', 'rm', '--force', '--volumes', names.gateway],
      ['network', 'rm', names.network],
    ])
    const copy = fake.calls.findIndex(args => args[0] === 'container' && args[1] === 'cp')
    const workerInspect = fake.calls.findIndex(args => args[0] === 'container' &&
      args[1] === 'inspect' && args.at(-1) === names.worker)
    expect(copy).toBeGreaterThan(workerInspect)
  })

  it('fails closed before worker start when Docker inspect reports a weakened sandbox', async () => {
    const request = await requestFixture()
    const fake = dockerFake({
      request,
      mutateInspect: (name, value) => {
        if (name === 'worker') (value.HostConfig as Record<string, unknown>).Privileged = true
      },
    })
    const supervisor = makeRestrictedCloneDockerSupervisor({
      docker: fake.docker,
      gatewayImageDigest: GATEWAY_IMAGE,
      listStaging: () => [],
      sleep: async () => {},
    })

    await expect(supervisor.run(request)).rejects.toEqual(
      new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_INSPECT_DENIED'),
    )
    const names = restrictedCloneDockerNames(request)
    expect(fake.calls).not.toContainEqual(['container', 'start', names.worker])
    expect(fake.calls).toContainEqual(['container', 'rm', '--force', '--volumes', names.worker])
  })

  it('rejects forged policy labels and credential-shaped image environment', async () => {
    const request = await requestFixture()
    const fake = dockerFake({
      request,
      mutateInspect: (name, value) => {
        if (name !== 'worker') return
        const config = value.Config as Record<string, unknown>
        ;(config.Labels as Record<string, unknown>)['com.aisy.clone.policy'] = 'c'.repeat(64)
        ;(config.Env as string[]).push('AISY_TOKEN=must-not-exist')
      },
    })
    const supervisor = makeRestrictedCloneDockerSupervisor({
      docker: fake.docker,
      gatewayImageDigest: GATEWAY_IMAGE,
      listStaging: () => [],
      sleep: async () => {},
    })

    await expect(supervisor.run(request)).rejects.toEqual(
      new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_INSPECT_DENIED'),
    )
  })

  it('attests OOM as quota-exceeded and still completes cleanup', async () => {
    const request = await requestFixture()
    const fake = dockerFake({
      request,
      workerStatus: { exitCode: 1, stdout: '', stderr: '' },
      workerStopped: { exitCode: 137, oomKilled: true },
    })
    const supervisor = makeRestrictedCloneDockerSupervisor({
      docker: fake.docker,
      gatewayImageDigest: GATEWAY_IMAGE,
      listStaging: () => [],
      sleep: async () => {},
    })

    await expect(supervisor.run(request)).resolves.toMatchObject({
      outcome: 'quota-exceeded',
      exitCode: 137,
      sandboxDestroyed: true,
    })
  })

  it('uses an uncancelled cleanup path and attests cancellation after policy application', async () => {
    const request = await requestFixture()
    const controller = new AbortController()
    const fake = dockerFake({
      request,
      workerStatus: { exitCode: 1, stdout: '', stderr: '', aborted: true },
      afterWorkerStatus: () => controller.abort(),
    })
    const supervisor = makeRestrictedCloneDockerSupervisor({
      docker: fake.docker,
      gatewayImageDigest: GATEWAY_IMAGE,
      listStaging: () => [],
      sleep: async () => {},
    })

    await expect(supervisor.run(request, controller.signal)).resolves.toMatchObject({
      outcome: 'cancelled',
      sandboxDestroyed: true,
    })
    expect(fake.signals.slice(-3)).toEqual([undefined, undefined, undefined])
  })

  it('attests a Docker command timeout only after verified policy and cleanup', async () => {
    const request = await requestFixture()
    const fake = dockerFake({
      request,
      workerStatus: { exitCode: 1, stdout: '', stderr: '', timedOut: true },
    })
    const supervisor = makeRestrictedCloneDockerSupervisor({
      docker: fake.docker,
      gatewayImageDigest: GATEWAY_IMAGE,
      listStaging: () => [],
      sleep: async () => {},
    })

    await expect(supervisor.run(request)).resolves.toMatchObject({
      outcome: 'timed-out',
      sandboxDestroyed: true,
    })
    expect(fake.signals.slice(-3)).toEqual([undefined, undefined, undefined])
  })

  it('refuses to attest destruction if cleanup fails', async () => {
    const request = await requestFixture()
    let staging: string[] = []
    const fake = dockerFake({
      request,
      afterCopy: () => { staging = ['README.md'] },
      failCleanup: true,
    })
    const supervisor = makeRestrictedCloneDockerSupervisor({
      docker: fake.docker,
      gatewayImageDigest: GATEWAY_IMAGE,
      listStaging: () => staging,
      sleep: async () => {},
    })

    await expect(supervisor.run(request)).rejects.toEqual(
      new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_CLEANUP_FAILED'),
    )
  })

  it('does not create Docker resources when staging is not empty', async () => {
    const request = await requestFixture()
    const run = vi.fn(async () => ok())
    const supervisor = makeRestrictedCloneDockerSupervisor({
      docker: { run },
      gatewayImageDigest: GATEWAY_IMAGE,
      listStaging: () => ['unexpected'],
    })

    await expect(supervisor.run(request)).rejects.toEqual(
      new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_STAGING_DENIED'),
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects an incompatible Docker runtime before creating any resources', async () => {
    const request = await requestFixture()
    const fake = dockerFake({ request, dockerVersion: '27.4.0' })
    const supervisor = makeRestrictedCloneDockerSupervisor({
      docker: fake.docker,
      gatewayImageDigest: GATEWAY_IMAGE,
      listStaging: () => [],
    })

    await expect(supervisor.run(request)).rejects.toEqual(
      new RestrictedCloneDockerSupervisorError('CLONE_DOCKER_RUNTIME_INCOMPATIBLE'),
    )
    expect(fake.calls).toEqual([['version', '--format={{.Server.Version}}']])
  })
})

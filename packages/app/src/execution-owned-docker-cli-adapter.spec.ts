import { describe, expect, it } from 'vitest'

import {
  hashExpectedOwnedDockerContainerProjection,
  hashExpectedOwnedDockerNetworkProjection,
  makeExecutionOwnedDockerCliAdapter,
  OwnedDockerCliAdapterError,
  type ExpectedOwnedDockerNetworkProjectionV1,
  type OwnedDockerCliCommandPort,
  type OwnedDockerCliCommandResult,
} from './execution-owned-docker-cli-adapter.js'

const INSTALLATION = 'a'.repeat(64)
const FOREIGN_INSTALLATION = 'b'.repeat(64)
const OWNER = 'c'.repeat(64)
const SESSION = 'd'.repeat(64)
const OPERATION = 'e'.repeat(64)
const POLICY = 'f'.repeat(64)
const CONTAINER_ID = '1'.repeat(64)
const IMAGE_ID = `sha256:${'3'.repeat(64)}`
const NETWORK_ID = '2'.repeat(64)
const NAME = 'aisy-bash-worker-1234567890abcdef12345678'
const MASKED_PATHS = [
  '/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys',
  '/proc/latency_stats', '/proc/sched_debug', '/proc/scsi', '/proc/timer_list',
  '/proc/timer_stats', '/sys/devices/virtual/powercap', '/sys/firmware',
].sort()
const READONLY_PATHS = ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger']

function ok(stdout = ''): OwnedDockerCliCommandResult {
  return { exitCode: 0, stdout, stderr: '' }
}

function failed(stderr = 'untrusted daemon detail'): OwnedDockerCliCommandResult {
  return { exitCode: 1, stdout: '', stderr }
}

class FakeRunner implements OwnedDockerCliCommandPort {
  readonly calls: string[][] = []
  readonly options: Array<{ timeoutMs: number; maxOutputBytes: number }> = []
  handler: (args: readonly string[]) => OwnedDockerCliCommandResult | Promise<OwnedDockerCliCommandResult> =
    () => failed()

  async run(
    args: readonly string[],
    options: Readonly<{ timeoutMs: number; maxOutputBytes: number }>,
  ): Promise<OwnedDockerCliCommandResult> {
    this.calls.push([...args])
    this.options.push({ ...options })
    return await this.handler(args)
  }
}

function labels(installationId = INSTALLATION, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'com.aisy.resource.version': '1',
    'com.aisy.resource.installation': installationId,
    'com.aisy.resource.owner': OWNER,
    'com.aisy.resource.session': SESSION,
    'com.aisy.resource.operation': OPERATION,
    'com.aisy.resource.kind': 'lease-bound-docker-bash',
    'com.aisy.resource.role': 'worker',
    'com.aisy.resource.policy': POLICY,
    ...extra,
  }
}

function containerInspect(input: {
  installationId?: string
  extraLabels?: Record<string, string>
  name?: string
  objectId?: string
} = {}): string {
  return JSON.stringify([
    input.objectId ?? CONTAINER_ID,
    `/${input.name ?? NAME}`,
    IMAGE_ID,
    {
      Image: `example.invalid/worker@sha256:${'3'.repeat(64)}`,
      User: '65532:65532',
      Cmd: ['-lc', 'payload-must-not-leak'],
      Env: ['LANG=C.UTF-8', 'LC_ALL=C.UTF-8'],
      Entrypoint: ['/bin/sh'],
      WorkingDir: '/work',
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
      Labels: labels(input.installationId, input.extraLabels),
      Healthcheck: { Test: ['NONE'] },
      StopSignal: 'SIGTERM',
    },
    {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: [],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges=true', 'seccomp=builtin'],
      GroupAdd: [],
      Sysctls: {},
      MaskedPaths: [...MASKED_PATHS],
      ReadonlyPaths: [...READONLY_PATHS],
      IpcMode: 'none',
      PidMode: '',
      UTSMode: '',
      CgroupnsMode: 'private',
      UsernsMode: '',
      PidsLimit: 64,
      Memory: 3 * 1024 * 1024 * 1024,
      MemorySwap: 3 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      Runtime: 'runc',
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      LogConfig: { Type: 'local', Config: { 'max-file': '1', 'max-size': '1048576', compress: 'false' } },
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,mode=0700' },
      Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
      Devices: [],
      DeviceRequests: [],
      PortBindings: {},
      PublishAllPorts: false,
      OomKillDisable: false,
      OomScoreAdj: 0,
      ShmSize: 64 * 1024 * 1024,
      Init: false,
    },
    [{
      Type: 'bind', Source: '/sensitive/root', Destination: '/work', RW: true,
      Propagation: 'rprivate', Name: '',
    }],
  ])
}

function networkInspect(endpointCount = 0): string {
  const networkLabels = labels()
  networkLabels['com.aisy.resource.kind'] = 'restricted-clone'
  networkLabels['com.aisy.resource.role'] = 'network'
  return JSON.stringify([
    NETWORK_ID,
    'aisy-clone-network-1234567890abcdef12345678',
    'ipvlan',
    true,
    false,
    false,
    false,
    {},
    { Driver: 'default', Options: {}, Config: [{ Subnet: '172.30.0.0/16' }] },
    networkLabels,
    Object.fromEntries(Array.from({ length: endpointCount }, (_, index) => [
      String(index + 4).repeat(64).slice(0, 64),
      { Name: `endpoint-${index}` },
    ])),
  ])
}

function withoutOwnershipLabels(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('com.aisy.resource.')))
}

function expectedContainerProjection() {
  const envelope = JSON.parse(containerInspect()) as [
    string, string, string, Record<string, unknown>, Record<string, unknown>, unknown[],
  ]
  const config = structuredClone(envelope[3])
  config['Labels'] = withoutOwnershipLabels(config['Labels'] as Record<string, string>)
  return {
    version: 1 as const,
    resourceKind: 'container' as const,
    imageId: envelope[2],
    config,
    hostConfig: structuredClone(envelope[4]),
    mounts: structuredClone(envelope[5]),
  }
}

function expectedNetworkProjection() {
  const envelope = JSON.parse(networkInspect()) as [
    string, string, string, boolean, boolean, boolean, boolean,
    Record<string, unknown>, Record<string, unknown>, Record<string, string>, Record<string, unknown>,
  ]
  return {
    version: 1 as const,
    resourceKind: 'network' as const,
    driver: envelope[2],
    internal: envelope[3],
    attachable: envelope[4],
    ingress: envelope[5],
    enableIpv6: envelope[6],
    options: structuredClone(envelope[7]),
    ipam: structuredClone(envelope[8]),
    labels: withoutOwnershipLabels(envelope[9]),
  }
}

function adapter(runner: FakeRunner) {
  return makeExecutionOwnedDockerCliAdapter({
    runner,
    installationId: INSTALLATION,
    binding: {
      version: 1,
      endpointBindingHash: '9'.repeat(64),
      serverVersion: '29.5.2',
      serverId: 'daemon:one',
    },
  })
}

describe('execution-owned Docker CLI adapter', () => {
  it('requires an exact pinned endpoint and version binding', () => {
    const runner = new FakeRunner()
    expect(() => makeExecutionOwnedDockerCliAdapter({
      runner,
      installationId: INSTALLATION,
      binding: {
        version: 1,
        endpointBindingHash: 'not-a-hash',
        serverVersion: '29.5.2',
        serverId: 'daemon:one',
      },
    })).toThrowError(expect.objectContaining({
      name: 'OwnedDockerCliAdapterError',
      code: 'OWNED_DOCKER_CLI_INPUT_INVALID',
      message: 'OWNED_DOCKER_CLI_INPUT_INVALID',
    } satisfies Partial<OwnedDockerCliAdapterError>))
  })

  it('rejects a pinned binding below the official minimum Docker version', () => {
    const runner = new FakeRunner()
    expect(() => makeExecutionOwnedDockerCliAdapter({
      runner,
      installationId: INSTALLATION,
      binding: {
        version: 1,
        endpointBindingHash: '9'.repeat(64),
        serverVersion: '29.5.1',
        serverId: 'daemon:one',
      },
    })).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_CLI_INPUT_INVALID' }))
  })

  it('probes the exact pinned server version and daemon id with bounded argv', async () => {
    const runner = new FakeRunner()
    runner.handler = args => args[0] === 'version' ? ok(JSON.stringify('29.5.2')) : ok(JSON.stringify('daemon:one'))
    const docker = adapter(runner)

    await expect(docker.probe()).resolves.toEqual({ kind: 'compatible' })
    expect(runner.calls).toEqual([
      ['version', '--format={{json .Server.Version}}'],
      ['info', '--format={{json .ID}}'],
    ])
    expect(runner.options).toEqual([
      { timeoutMs: 10_000, maxOutputBytes: 256 * 1024 },
      { timeoutMs: 10_000, maxOutputBytes: 256 * 1024 },
    ])
    expect(docker.endpointBindingHash).toBe('9'.repeat(64))

    runner.calls.length = 0
    runner.handler = args => args[0] === 'version' ? ok(JSON.stringify('29.5.3')) : ok(JSON.stringify('daemon:one'))
    await expect(docker.probe()).resolves.toEqual({ kind: 'incompatible' })

    runner.handler = args => args[0] === 'version' ? ok(JSON.stringify('29.5.1')) : ok(JSON.stringify('daemon:one'))
    await expect(docker.probe()).resolves.toEqual({ kind: 'incompatible' })

    runner.handler = () => failed('https://sensitive.invalid/?token=must-not-leak')
    await expect(docker.probe()).resolves.toEqual({ kind: 'ambiguous' })
  })

  it('scans only the exact installation label and returns opaque canonical hashes', async () => {
    const runner = new FakeRunner()
    runner.handler = args => {
      const joined = args.join(' ')
      if (joined.startsWith('container ls')) return ok(`${JSON.stringify(CONTAINER_ID)}\n`)
      if (joined.startsWith('network ls')) return ok('')
      if (joined.startsWith('inspect --type=container')) return ok(containerInspect())
      return failed()
    }
    const docker = adapter(runner)

    const result = await docker.scanInstallation(INSTALLATION)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('test fixture')
    expect(result.resources).toHaveLength(1)
    expect(result.resources[0]).toMatchObject({
      objectId: CONTAINER_ID,
      resourceKind: 'container',
      name: NAME,
      networkEndpointCount: null,
      labels: { installationId: INSTALLATION, role: 'worker' },
    })
    expect(result.resources[0]).toMatchObject({
      version: 2,
      createProjectionContract: 'container-selected-v2',
      createProjectionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      projectionHashV1: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(JSON.stringify(result)).not.toContain('sensitive')
    expect(runner.calls.slice(0, 2)).toEqual([
      [
        'container', 'ls', '--all', '--no-trunc',
        `--filter=label=com.aisy.resource.installation=${INSTALLATION}`,
        '--format={{json .ID}}',
      ],
      [
        'network', 'ls', '--no-trunc',
        `--filter=label=com.aisy.resource.installation=${INSTALLATION}`,
        '--format={{json .ID}}',
      ],
    ])
  })

  it('uses one canonical container path before prepare and after inspect', async () => {
    const expected = hashExpectedOwnedDockerContainerProjection(expectedContainerProjection())
    const runner = new FakeRunner()
    runner.handler = () => ok(containerInspect())
    const observed = await adapter(runner).inspectById({
      resourceKind: 'container', objectId: CONTAINER_ID,
    })

    expect(observed.kind).toBe('found')
    if (observed.kind !== 'found') throw new Error('test fixture')
    expect(observed.resource.projectionHashV1).toBe(expected)
    expect(expected).toMatch(/^[a-f0-9]{64}$/)
    expect(expected).not.toContain('payload-must-not-leak')
  })

  it('changes the container projection hash on config or confinement drift', () => {
    const baseline = expectedContainerProjection()
    const configDrift = structuredClone(baseline)
    ;(configDrift.config['Env'] as string[]).push('EXTRA=drift')
    const policyDrift = structuredClone(baseline)
    policyDrift.hostConfig['Privileged'] = true

    expect(hashExpectedOwnedDockerContainerProjection(configDrift))
      .not.toBe(hashExpectedOwnedDockerContainerProjection(baseline))
    expect(hashExpectedOwnedDockerContainerProjection(policyDrift))
      .not.toBe(hashExpectedOwnedDockerContainerProjection(baseline))
  })

  it('rejects unknown labels in the closed com.aisy namespace', async () => {
    const runner = new FakeRunner()
    runner.handler = () => ok(containerInspect({
      extraLabels: { 'com.aisy.clone.execution': 'legacy' },
    }))

    await expect(adapter(runner).inspectById({
      resourceKind: 'container', objectId: CONTAINER_ID,
    })).resolves.toEqual({ kind: 'ambiguous' })

    const expected = expectedContainerProjection()
    ;(expected.config['Labels'] as Record<string, string>)['com.aisy.unplanned'] = 'denied'
    expect(() => hashExpectedOwnedDockerContainerProjection(expected)).toThrowError(
      expect.objectContaining({
        code: 'OWNED_DOCKER_CLI_INPUT_INVALID',
        message: 'OWNED_DOCKER_CLI_INPUT_INVALID',
      }),
    )
  })

  it('treats absence as proven only by a transport-certain typed Docker Engine 404', async () => {
    const typedRunner = new FakeRunner()
    typedRunner.handler = () => ({ ...failed(), dockerErrorCode: 'object-not-found' })
    await expect(adapter(typedRunner).inspectById({
      resourceKind: 'container', objectId: CONTAINER_ID,
    })).resolves.toEqual({ kind: 'absent' })
    expect(typedRunner.calls).toHaveLength(1)

    for (const contradictory of [
      { timedOut: true }, { aborted: true }, { overflow: true },
      { stdout: 'contradiction' }, { exitCode: 0 },
    ]) {
      const runner = new FakeRunner()
      runner.handler = () => ({
        ...failed(),
        dockerErrorCode: 'object-not-found',
        ...contradictory,
      })
      await expect(adapter(runner).inspectById({
        resourceKind: 'container', objectId: CONTAINER_ID,
      })).resolves.toEqual({ kind: 'ambiguous' })
    }

    // This is the exact fail-closed behaviour of the existing Node runner,
    // which has no Engine-aware typed 404 and must not parse stderr.
    const genericRunner = new FakeRunner()
    genericRunner.handler = () => failed()
    await expect(adapter(genericRunner).inspectById({
      resourceKind: 'container', objectId: CONTAINER_ID,
    })).resolves.toEqual({ kind: 'ambiguous' })
    expect(genericRunner.calls).toHaveLength(1)
  })

  it('never authorizes removal of a resource from another installation', async () => {
    const runner = new FakeRunner()
    runner.handler = args => args[0] === 'inspect'
      ? ok(containerInspect({ installationId: FOREIGN_INSTALLATION }))
      : ok()
    const docker = adapter(runner)

    await expect(docker.inspectById({ resourceKind: 'container', objectId: CONTAINER_ID }))
      .resolves.toMatchObject({ kind: 'found' })
    await expect(docker.removeById({ resourceKind: 'container', objectId: CONTAINER_ID }))
      .resolves.toEqual({ kind: 'ambiguous' })
    expect(runner.calls.filter(call => call[0] === 'container' && call[1] === 'rm')).toEqual([])
  })

  it('removes an exactly re-inspected owned container by immutable id', async () => {
    const runner = new FakeRunner()
    runner.handler = args => args[0] === 'inspect' ? ok(containerInspect()) : ok()
    const docker = adapter(runner)

    await expect(docker.inspectById({ resourceKind: 'container', objectId: CONTAINER_ID }))
      .resolves.toMatchObject({ kind: 'found' })
    expect(runner.calls[0]).toEqual([
      'inspect',
      '--type=container',
      '--format=[{{json .Id}},{{json .Name}},{{json .Image}},{{json .Config}},{{json .HostConfig}},{{json .Mounts}}]',
      CONTAINER_ID,
    ])
    await expect(docker.removeById({ resourceKind: 'container', objectId: CONTAINER_ID }))
      .resolves.toEqual({ kind: 'removed' })
    expect(runner.calls.at(-1)).toEqual([
      'container', 'rm', '--force', '--volumes', CONTAINER_ID,
    ])
  })

  it('does not accept a contradictory typed 404 from remove as absence', async () => {
    const runner = new FakeRunner()
    runner.handler = () => ok(containerInspect())
    const docker = adapter(runner)
    await expect(docker.inspectById({ resourceKind: 'container', objectId: CONTAINER_ID }))
      .resolves.toMatchObject({ kind: 'found' })

    runner.handler = () => ({
      ...failed(),
      dockerErrorCode: 'object-not-found',
      timedOut: true,
    })
    await expect(docker.removeById({ resourceKind: 'container', objectId: CONTAINER_ID }))
      .resolves.toEqual({ kind: 'ambiguous' })
  })

  it('projects network policy separately from exact endpoint cardinality', async () => {
    const runner = new FakeRunner()
    runner.handler = () => ok(networkInspect(1))
    const docker = adapter(runner)

    const result = await docker.inspectById({ resourceKind: 'network', objectId: NETWORK_ID })
    expect(result.kind).toBe('found')
    if (result.kind !== 'found') throw new Error('test fixture')
    expect(result.resource).toMatchObject({
      objectId: NETWORK_ID,
      resourceKind: 'network',
      networkEndpointCount: 1,
      labels: { installationId: INSTALLATION, role: 'network' },
    })
    expect(result.resource.projectionHashV1).toMatch(/^[a-f0-9]{64}$/)
    expect(result.resource.createProjectionContract).toBe('network-full-v1')
    expect(result.resource.createProjectionHash).toBe(
      hashExpectedOwnedDockerNetworkProjection(expectedNetworkProjection()),
    )
    expect(result.resource.projectionHashV1).toBe(result.resource.createProjectionHash)
    expect(runner.calls[0]).toEqual([
      'inspect',
      '--type=network',
      '--format=[{{json .Id}},{{json .Name}},{{json .Driver}},{{json .Internal}},{{json .Attachable}},{{json .Ingress}},{{json .EnableIPv6}},{{json .Options}},{{json .IPAM}},{{json .Labels}},{{json .Containers}}]',
      NETWORK_ID,
    ])

    const noEndpointsRunner = new FakeRunner()
    noEndpointsRunner.handler = () => ok(networkInspect(0))
    const noEndpoints = await adapter(noEndpointsRunner).inspectById({
      resourceKind: 'network', objectId: NETWORK_ID,
    })
    expect(noEndpoints.kind).toBe('found')
    if (noEndpoints.kind !== 'found') throw new Error('test fixture')
    expect(noEndpoints.resource.networkEndpointCount).toBe(0)
    expect(noEndpoints.resource.projectionHashV1).toBe(result.resource.projectionHashV1)
  })

  it('changes the network projection hash on policy drift and rejects non-JSON plans', () => {
    const baseline = expectedNetworkProjection()
    const drift = structuredClone(baseline)
    drift.internal = false
    expect(hashExpectedOwnedDockerNetworkProjection(drift))
      .not.toBe(hashExpectedOwnedDockerNetworkProjection(baseline))

    const config = expectedContainerProjection().config
    Object.defineProperty(config, 'Labels', {
      enumerable: true,
      get: () => ({ 'untrusted': 'getter' }),
    })
    expect(() => hashExpectedOwnedDockerContainerProjection({
      ...expectedContainerProjection(),
      config,
    })).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_CLI_INPUT_INVALID' }))

    const symbolPlan = expectedNetworkProjection() as ExpectedOwnedDockerNetworkProjectionV1 & {
      [key: symbol]: string
    }
    symbolPlan[Symbol('hidden')] = 'denied'
    expect(() => hashExpectedOwnedDockerNetworkProjection(symbolPlan))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_CLI_INPUT_INVALID' }))
  })

  it('fails closed on malformed, overflowing or excessive list output', async () => {
    const malformed = new FakeRunner()
    malformed.handler = () => ok('{"not":"an-id"}\n')
    await expect(adapter(malformed).scanInstallation(INSTALLATION))
      .resolves.toEqual({ kind: 'ambiguous' })

    const excessive = new FakeRunner()
    excessive.handler = args => args[0] === 'container'
      ? ok(Array.from({ length: 4_097 }, (_, index) => JSON.stringify(
        index.toString(16).padStart(64, '0'),
      )).join('\n') + '\n')
      : ok('')
    await expect(adapter(excessive).scanInstallation(INSTALLATION))
      .resolves.toEqual({ kind: 'ambiguous' })
  })
})

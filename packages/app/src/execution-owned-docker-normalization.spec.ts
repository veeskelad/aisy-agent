import { describe, expect, it } from 'vitest'

import {
  normalizeOwnedDockerContainerInspectProjectionV2,
} from './docker-container-selected-projection.js'
import {
  hashExpectedOwnedDockerContainerProjection as hashCliContainerProjection,
  hashExpectedOwnedDockerNetworkProjection as hashCliNetworkProjection,
  makeExecutionOwnedDockerCliAdapter,
  type OwnedDockerCliCommandPort,
  type OwnedDockerCliCommandResult,
} from './execution-owned-docker-cli-adapter.js'
import {
  hashExpectedOwnedDockerContainerProjection,
  hashExpectedOwnedDockerNetworkProjection,
  normalizeOwnedDockerContainerInspect,
  normalizeOwnedDockerNetworkInspect,
  OwnedDockerNormalizationError,
} from './execution-owned-docker-normalization.js'

const INSTALLATION = 'a'.repeat(64)
const OWNER = 'b'.repeat(64)
const SESSION = 'c'.repeat(64)
const OPERATION = 'd'.repeat(64)
const POLICY = 'e'.repeat(64)
const CONTAINER_ID = '1'.repeat(64)
const IMAGE_ID = `sha256:${'3'.repeat(64)}`
const NETWORK_ID = '2'.repeat(64)
const NAME = 'aisy-clone-worker-1234567890abcdef12345678'
const BASH_NAME = 'aisy-bash-worker-1234567890abcdef12345678'
const MASKED_PATHS = [
  '/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys',
  '/proc/latency_stats', '/proc/sched_debug', '/proc/scsi', '/proc/timer_list',
  '/proc/timer_stats', '/sys/devices/virtual/powercap', '/sys/firmware',
].sort()
const READONLY_PATHS = ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger']

function labels(role: 'worker' | 'network' = 'worker'): Record<string, string> {
  return {
    'com.aisy.resource.version': '1',
    'com.aisy.resource.installation': INSTALLATION,
    'com.aisy.resource.owner': OWNER,
    'com.aisy.resource.session': SESSION,
    'com.aisy.resource.operation': OPERATION,
    'com.aisy.resource.kind': 'restricted-clone',
    'com.aisy.resource.role': role,
    'com.aisy.resource.policy': POLICY,
    'user.label': 'preserved-in-projection',
  }
}

function containerDocument(): Record<string, unknown> {
  return {
    Id: CONTAINER_ID,
    Name: `/${NAME}`,
    Image: IMAGE_ID,
    Config: {
      Image: `example.invalid/worker@sha256:${'3'.repeat(64)}`,
      User: '65532:65532',
      Cmd: ['sh', '-lc', 'payload-must-not-leak'],
      Env: ['AISY_CLONE_URL=https://sensitive.invalid/private'],
      Labels: labels(),
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      Binds: ['/sensitive/root:/work:rw'],
    },
    Mounts: [{ Type: 'bind', Source: '/sensitive/root', Destination: '/work', RW: true }],
    State: { Status: 'running' },
  }
}

function selectedContainerDocument(): Record<string, unknown> {
  return {
    Id: CONTAINER_ID,
    Name: `/${BASH_NAME}`,
    Image: IMAGE_ID,
    Config: {
      Image: `example.invalid/bash@sha256:${'4'.repeat(64)}`,
      User: '65532:65532',
      Env: ['PATH=/usr/bin', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8'],
      Entrypoint: ['/bin/sh'],
      Cmd: ['-lc', 'printf sensitive-command'],
      WorkingDir: '/work',
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
      Labels: {
        ...labels(),
        'com.aisy.resource.kind': 'lease-bound-docker-bash',
        'org.opencontainers.image.title': 'aisy-bash',
      },
      Healthcheck: { Test: ['NONE'] },
      StopSignal: 'SIGTERM',
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      CapAdd: [],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges=true', 'seccomp=builtin'],
      GroupAdd: [],
      Sysctls: {},
      MaskedPaths: [...MASKED_PATHS].reverse(),
      ReadonlyPaths: [...READONLY_PATHS],
      IpcMode: 'none',
      PidMode: '',
      UTSMode: '',
      CgroupnsMode: 'private',
      UsernsMode: '',
      PidsLimit: 64,
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      Runtime: 'runc',
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      LogConfig: {
        Type: 'local', Config: { 'max-file': '1', 'max-size': '1048576', compress: 'false' },
      },
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
    Mounts: [{
      Type: 'bind', Source: '/private/var/aisy/workspace', Destination: '/work',
      RW: true, Propagation: 'rprivate',
    }],
    State: { Status: 'created' },
  }
}

function networkDocument(endpointCount = 1): Record<string, unknown> {
  return {
    Id: NETWORK_ID,
    Name: 'aisy-clone-network-1234567890abcdef12345678',
    Driver: 'ipvlan',
    Internal: true,
    Attachable: false,
    Ingress: false,
    EnableIPv6: false,
    Options: {},
    IPAM: { Driver: 'default', Options: {}, Config: [{ Subnet: '172.30.0.0/16' }] },
    Labels: labels('network'),
    Containers: Object.fromEntries(Array.from({ length: endpointCount }, (_, index) => [
      (index + 4).toString(16).padStart(64, '0'),
      { Name: `endpoint-${index}` },
    ])),
  }
}

function withoutOwnership(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('com.aisy.')))
}

function expectedContainerProjection() {
  const document = containerDocument()
  const config = structuredClone(document['Config']) as Record<string, unknown>
  config['Labels'] = withoutOwnership(config['Labels'] as Record<string, string>)
  return {
    version: 1 as const,
    resourceKind: 'container' as const,
    imageId: document['Image'] as string,
    config,
    hostConfig: structuredClone(document['HostConfig']) as Record<string, unknown>,
    mounts: structuredClone(document['Mounts']) as unknown[],
  }
}

function expectedNetworkProjection() {
  const document = networkDocument()
  return {
    version: 1 as const,
    resourceKind: 'network' as const,
    driver: document['Driver'] as string,
    internal: document['Internal'] as boolean,
    attachable: document['Attachable'] as boolean,
    ingress: document['Ingress'] as boolean,
    enableIpv6: document['EnableIPv6'] as boolean,
    options: structuredClone(document['Options']) as Record<string, unknown>,
    ipam: structuredClone(document['IPAM']) as Record<string, unknown>,
    labels: withoutOwnership(document['Labels'] as Record<string, string>),
  }
}

class InspectRunner implements OwnedDockerCliCommandPort {
  calls = 0
  constructor(private readonly output: string) {}
  async run(): Promise<OwnedDockerCliCommandResult> {
    this.calls += 1
    return { exitCode: 0, stdout: this.output, stderr: '' }
  }
}

function cliContainerOutput(document: Record<string, unknown>): string {
  return JSON.stringify([
    document['Id'], document['Name'], document['Image'], document['Config'],
    document['HostConfig'], document['Mounts'],
  ])
}

function cliNetworkOutput(document: Record<string, unknown>): string {
  return JSON.stringify([
    document['Id'], document['Name'], document['Driver'], document['Internal'], document['Attachable'],
    document['Ingress'], document['EnableIPv6'], document['Options'], document['IPAM'],
    document['Labels'], document['Containers'],
  ])
}

function expectNormalizationFailure(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({
    name: 'OwnedDockerNormalizationError',
    code: 'OWNED_DOCKER_NORMALIZATION_INVALID',
    message: 'OWNED_DOCKER_NORMALIZATION_INVALID',
  } satisfies Partial<OwnedDockerNormalizationError>))
}

describe('owned Docker Engine inspect normalization', () => {
  it('keeps the legacy full container V1 normalizer and hash semantics unchanged', () => {
    const document = containerDocument()
    const normalized = normalizeOwnedDockerContainerInspect(document)
    const expectedHash = hashExpectedOwnedDockerContainerProjection(expectedContainerProjection())
    const cliHash = hashCliContainerProjection(expectedContainerProjection())

    expect(normalized.projectionHash).toBe(expectedHash)
    expect(cliHash).toBe(expectedHash)
    expect(expectedHash).toBe('9477f0c0f5d158b9bf2bc3b79d78a7fd83ddc44fbf703350c45b78216fc2df46')
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.labels)).toBe(true)
    expect(JSON.stringify(normalized)).not.toContain('sensitive')
  })

  it('builds CLI container V2 selected and full hashes from one inspect response', async () => {
    const document = selectedContainerDocument()
    const legacy = normalizeOwnedDockerContainerInspect(document)
    const selected = normalizeOwnedDockerContainerInspectProjectionV2(document)
    const runner = new InspectRunner(cliContainerOutput(document))
    const cli = makeExecutionOwnedDockerCliAdapter({
      runner,
      installationId: INSTALLATION,
      binding: {
        version: 1,
        endpointBindingHash: '9'.repeat(64),
        serverVersion: '29.5.2',
        serverId: 'daemon:one',
      },
    })

    const observed = await cli.inspectById({ resourceKind: 'container', objectId: CONTAINER_ID })

    expect(runner.calls).toBe(1)
    expect(observed).toEqual({
      kind: 'found',
      resource: {
        version: 2,
        objectId: legacy.objectId,
        resourceKind: 'container',
        name: legacy.name,
        labels: legacy.labels,
        createProjectionContract: 'container-selected-v2',
        createProjectionHash: selected.projectionHash,
        projectionHashV1: legacy.projectionHash,
        networkEndpointCount: null,
      },
    })
    if (observed.kind !== 'found') throw new Error('expected found')
    expect(observed.resource.createProjectionHash).not.toBe(observed.resource.projectionHashV1)
    expect(JSON.stringify(observed.resource)).not.toContain('sensitive')
    expect(Object.isFrozen(observed.resource)).toBe(true)
  })

  it('keeps network V1 hashing separate while CLI V2 reuses full hash and reports cardinality', async () => {
    const withEndpoint = normalizeOwnedDockerNetworkInspect(networkDocument(2))
    const empty = normalizeOwnedDockerNetworkInspect(networkDocument(0))
    const plan = expectedNetworkProjection()
    const document = networkDocument(2)
    const runner = new InspectRunner(cliNetworkOutput(document))
    const cli = makeExecutionOwnedDockerCliAdapter({
      runner,
      installationId: INSTALLATION,
      binding: {
        version: 1,
        endpointBindingHash: '9'.repeat(64),
        serverVersion: '29.5.2',
        serverId: 'daemon:one',
      },
    })
    const cliObserved = await cli.inspectById({ resourceKind: 'network', objectId: NETWORK_ID })

    expect(runner.calls).toBe(1)
    expect(cliObserved).toEqual({
      kind: 'found',
      resource: {
        version: 2,
        objectId: withEndpoint.objectId,
        resourceKind: 'network',
        name: withEndpoint.name,
        labels: withEndpoint.labels,
        createProjectionContract: 'network-full-v1',
        createProjectionHash: withEndpoint.projectionHash,
        projectionHashV1: withEndpoint.projectionHash,
        networkEndpointCount: 2,
      },
    })
    expect(withEndpoint.networkEndpointCount).toBe(2)
    expect(empty.networkEndpointCount).toBe(0)
    expect(withEndpoint.projectionHash).toBe(empty.projectionHash)
    expect(empty.projectionHash).toBe(hashExpectedOwnedDockerNetworkProjection(plan))
    expect(empty.projectionHash).toBe('52b5f93a146f6e4d483c6fcb06285576b0079c9f4f5af0f4f286a319a5fc1e97')
    expect(hashCliNetworkProjection(plan)).toBe(empty.projectionHash)
    expect(Object.isFrozen(withEndpoint)).toBe(true)
    expect(Object.isFrozen(withEndpoint.labels)).toBe(true)
  })

  it('binds the executed image config ID independently from Config.Image', () => {
    const baselineDocument = containerDocument()
    const baseline = normalizeOwnedDockerContainerInspect(baselineDocument).projectionHash
    const changedDocument = containerDocument()
    changedDocument['Image'] = `sha256:${'4'.repeat(64)}`
    const changed = normalizeOwnedDockerContainerInspect(changedDocument).projectionHash

    expect(changed).not.toBe(baseline)
    const expected = expectedContainerProjection()
    expect(hashExpectedOwnedDockerContainerProjection({
      ...expected,
      imageId: `sha256:${'4'.repeat(64)}`,
    })).toBe(changed)

    for (const imageId of [undefined, '3'.repeat(64), `sha256:${'z'.repeat(64)}`]) {
      const invalid = containerDocument()
      if (imageId === undefined) delete invalid['Image']
      else invalid['Image'] = imageId
      expectNormalizationFailure(() => normalizeOwnedDockerContainerInspect(invalid))
    }
    expectNormalizationFailure(() => hashExpectedOwnedDockerContainerProjection({
      ...expected,
      imageId: 'sha256:invalid',
    }))
  })

  it('does not invoke inherited toJSON while hashing expected or observed projections', () => {
    const expectedContainer = hashExpectedOwnedDockerContainerProjection(expectedContainerProjection())
    const expectedNetwork = hashExpectedOwnedDockerNetworkProjection(expectedNetworkProjection())
    const priorObjectToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    const priorArrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
    let calls = 0
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value() {
          calls += 1
          return 'collapsed-object'
        },
      })
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value() {
          calls += 1
          return 'collapsed-array'
        },
      })

      expect(hashExpectedOwnedDockerContainerProjection(expectedContainerProjection()))
        .toBe(expectedContainer)
      expect(hashExpectedOwnedDockerNetworkProjection(expectedNetworkProjection()))
        .toBe(expectedNetwork)
      expect(normalizeOwnedDockerContainerInspect(containerDocument()).projectionHash)
        .toBe(expectedContainer)
      expect(normalizeOwnedDockerNetworkInspect(networkDocument()).projectionHash)
        .toBe(expectedNetwork)
      expect(calls).toBe(0)
    } finally {
      if (priorObjectToJson === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON
      else Object.defineProperty(Object.prototype, 'toJSON', priorObjectToJson)
      if (priorArrayToJson === undefined) delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON
      else Object.defineProperty(Array.prototype, 'toJSON', priorArrayToJson)
    }
  })

  it('rejects accessors and proxies without invoking hostile code', () => {
    let getterCalls = 0
    const getterDocument = containerDocument()
    Object.defineProperty(getterDocument['Config'] as Record<string, unknown>, 'Labels', {
      enumerable: true,
      get() {
        getterCalls += 1
        return labels()
      },
    })
    expectNormalizationFailure(() => normalizeOwnedDockerContainerInspect(getterDocument))
    expect(getterCalls).toBe(0)

    let trapCalls = 0
    const proxyDocument = containerDocument()
    proxyDocument['HostConfig'] = new Proxy({}, {
      getPrototypeOf() {
        trapCalls += 1
        return Object.prototype
      },
      ownKeys() {
        trapCalls += 1
        return []
      },
    })
    expectNormalizationFailure(() => normalizeOwnedDockerContainerInspect(proxyDocument))
    expect(trapCalls).toBe(0)
  })

  it('rejects symbols, duplicate label/member representations and extra com.aisy labels', () => {
    const symbolDocument = containerDocument()
    ;(symbolDocument['Config'] as Record<symbol, unknown>)[Symbol('hidden')] = 'denied'
    expectNormalizationFailure(() => normalizeOwnedDockerContainerInspect(symbolDocument))

    for (const key of ['com.aisy.unplanned', 'com.aisy.resource.Role']) {
      const document = containerDocument()
      ;((document['Config'] as Record<string, unknown>)['Labels'] as Record<string, string>)[key] = 'denied'
      expectNormalizationFailure(() => normalizeOwnedDockerContainerInspect(document))
    }

    const duplicateLabels = containerDocument()
    const labelEntries = Object.entries(labels())
    ;(duplicateLabels['Config'] as Record<string, unknown>)['Labels'] = [
      ...labelEntries,
      ['com.aisy.resource.role', 'worker'],
    ]
    expectNormalizationFailure(() => normalizeOwnedDockerContainerInspect(duplicateLabels))

    const duplicateMembers = networkDocument()
    duplicateMembers['Containers'] = [
      [CONTAINER_ID, {}],
      [CONTAINER_ID, {}],
    ]
    expectNormalizationFailure(() => normalizeOwnedDockerNetworkInspect(duplicateMembers))

    const invalidMember = networkDocument()
    ;(invalidMember['Containers'] as Record<string, unknown>)['not-an-immutable-id'] = {}
    expectNormalizationFailure(() => normalizeOwnedDockerNetworkInspect(invalidMember))

    expectNormalizationFailure(() => normalizeOwnedDockerNetworkInspect(networkDocument(4_097)))
  })

  it('bounds nested JSON depth and returns only a stable code-only error', () => {
    const document = containerDocument()
    let nested: Record<string, unknown> = {}
    ;(document['HostConfig'] as Record<string, unknown>)['Nested'] = nested
    for (let index = 0; index < 33; index += 1) {
      const next: Record<string, unknown> = {}
      nested['next'] = next
      nested = next
    }

    expectNormalizationFailure(() => normalizeOwnedDockerContainerInspect(document))
  })

  it('bounds cumulative UTF-8 text for giant scalar values and keys', () => {
    const giantScalar = 'x'.repeat(1024 * 1024 + 1)
    const scalarDocument = containerDocument()
    ;(scalarDocument['Config'] as Record<string, unknown>)['Env'] = [giantScalar]
    expectNormalizationFailure(() => normalizeOwnedDockerContainerInspect(scalarDocument))

    const giantKey = 'k'.repeat(1024 * 1024 + 1)
    const keyDocument = containerDocument()
    ;(keyDocument['HostConfig'] as Record<string, unknown>)[giantKey] = true
    expectNormalizationFailure(() => normalizeOwnedDockerContainerInspect(keyDocument))

    const plan = expectedContainerProjection()
    ;(plan.config['Env'] as string[])[0] = giantScalar
    expectNormalizationFailure(() => hashExpectedOwnedDockerContainerProjection(plan))
    expect(() => hashCliContainerProjection(plan)).toThrowError(expect.objectContaining({
      name: 'OwnedDockerCliAdapterError',
      code: 'OWNED_DOCKER_CLI_INPUT_INVALID',
      message: 'OWNED_DOCKER_CLI_INPUT_INVALID',
    }))
  })

  it('rejects more than fifty thousand canonical nodes', () => {
    const document = containerDocument()
    document['Mounts'] = Array.from({ length: 50_001 }, () => null)
    expectNormalizationFailure(() => normalizeOwnedDockerContainerInspect(document))
  })
})

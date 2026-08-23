import { describe, expect, it } from 'vitest'

import {
  DockerContainerSelectedProjectionError,
  hashExpectedOwnedDockerContainerProjectionV2,
  normalizeOwnedDockerContainerInspectProjectionV2,
  type ExpectedOwnedDockerContainerProjectionV2,
} from './docker-container-selected-projection.js'

const IMAGE_ID = `sha256:${'a'.repeat(64)}`
const IMAGE_REFERENCE = `registry.example/aisy/bash@sha256:${'b'.repeat(64)}`
const SOURCE = '/private/var/aisy/workspace'
const MASKED_PATHS = [
  '/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys',
  '/proc/latency_stats', '/proc/sched_debug', '/proc/scsi', '/proc/timer_list',
  '/proc/timer_stats', '/sys/devices/virtual/powercap', '/sys/firmware',
].sort()
const READONLY_PATHS = ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger']

function ownershipLabels(): Record<string, string> {
  return {
    'com.aisy.resource.version': '1',
    'com.aisy.resource.installation': '1'.repeat(64),
    'com.aisy.resource.owner': '2'.repeat(64),
    'com.aisy.resource.session': '3'.repeat(64),
    'com.aisy.resource.operation': '4'.repeat(64),
    'com.aisy.resource.kind': 'lease-bound-docker-bash',
    'com.aisy.resource.role': 'worker',
    'com.aisy.resource.policy': '5'.repeat(64),
  }
}

function expected(): ExpectedOwnedDockerContainerProjectionV2 {
  return {
    version: 2,
    resourceKind: 'container',
    sidecarKind: 'lease-bound-docker-bash',
    role: 'worker',
    imageId: IMAGE_ID,
    config: {
      image: IMAGE_REFERENCE,
      user: '65532:65532',
      env: ['PATH=/usr/bin', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8'],
      entrypoint: ['/bin/sh'],
      cmd: ['-lc', 'printf sensitive-command'],
      workingDir: '/work',
      openStdin: false,
      stdinOnce: false,
      tty: false,
      labels: { 'org.opencontainers.image.title': 'aisy-bash' },
      healthcheckDisabled: true,
      stopSignal: 'SIGTERM',
    },
    hostConfig: {
      networkMode: 'none',
      readonlyRootfs: true,
      privileged: false,
      capAdd: [],
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges=true', 'seccomp=builtin'],
      groupAdd: [],
      sysctls: {},
      maskedPaths: MASKED_PATHS,
      readonlyPaths: READONLY_PATHS,
      ipcMode: 'none',
      pidMode: '',
      utsMode: '',
      cgroupnsMode: 'private',
      usernsMode: '',
      pidsLimit: 64,
      memory: 512 * 1024 * 1024,
      memorySwap: 512 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      runtime: 'runc',
      restartPolicy: { name: 'no', maximumRetryCount: 0 },
      autoRemove: false,
      logConfig: {
        type: 'local',
        config: { 'max-file': '1', 'max-size': '1048576', compress: 'false' },
      },
      tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,mode=0700' },
      ulimits: [{ name: 'nofile', soft: 1024, hard: 1024 }],
      devices: [],
      deviceRequests: [],
      portBindings: {},
      publishAllPorts: false,
      oomKillDisable: false,
      oomScoreAdj: 0,
      shmSize: 64 * 1024 * 1024,
      init: false,
    },
    mounts: [{
      type: 'bind', source: SOURCE, destination: '/work', readOnly: false, propagation: 'rprivate',
    }],
  }
}

function inspect(): Record<string, unknown> {
  const plan = expected()
  return {
    Id: 'c'.repeat(64),
    Name: '/aisy-bash-example',
    Image: plan.imageId,
    Config: {
      Hostname: 'daemon-generated-value',
      Image: plan.config.image,
      User: plan.config.user,
      Env: [...plan.config.env],
      Entrypoint: [...plan.config.entrypoint],
      Cmd: [...plan.config.cmd],
      WorkingDir: plan.config.workingDir,
      OpenStdin: plan.config.openStdin,
      StdinOnce: plan.config.stdinOnce,
      Tty: plan.config.tty,
      Labels: { ...ownershipLabels(), ...plan.config.labels },
      Healthcheck: { Test: ['NONE'] },
      StopSignal: plan.config.stopSignal,
      AttachStdin: false,
    },
    HostConfig: {
      NetworkMode: plan.hostConfig.networkMode,
      ReadonlyRootfs: plan.hostConfig.readonlyRootfs,
      Privileged: plan.hostConfig.privileged,
      CapAdd: [...plan.hostConfig.capAdd],
      CapDrop: [...plan.hostConfig.capDrop],
      SecurityOpt: [...plan.hostConfig.securityOpt],
      GroupAdd: [],
      Sysctls: {},
      MaskedPaths: [...plan.hostConfig.maskedPaths].reverse(),
      ReadonlyPaths: [...plan.hostConfig.readonlyPaths],
      IpcMode: plan.hostConfig.ipcMode,
      PidMode: plan.hostConfig.pidMode,
      UTSMode: plan.hostConfig.utsMode,
      CgroupnsMode: plan.hostConfig.cgroupnsMode,
      UsernsMode: plan.hostConfig.usernsMode,
      PidsLimit: plan.hostConfig.pidsLimit,
      Memory: plan.hostConfig.memory,
      MemorySwap: plan.hostConfig.memorySwap,
      NanoCpus: plan.hostConfig.nanoCpus,
      Runtime: plan.hostConfig.runtime,
      RestartPolicy: {
        Name: plan.hostConfig.restartPolicy.name,
        MaximumRetryCount: plan.hostConfig.restartPolicy.maximumRetryCount,
      },
      AutoRemove: plan.hostConfig.autoRemove,
      LogConfig: { Type: plan.hostConfig.logConfig.type, Config: { ...plan.hostConfig.logConfig.config } },
      Tmpfs: { ...plan.hostConfig.tmpfs },
      Ulimits: plan.hostConfig.ulimits.map(item => ({
        Name: item.name, Soft: item.soft, Hard: item.hard,
      })),
      Devices: [],
      DeviceRequests: [],
      PortBindings: {},
      PublishAllPorts: false,
      OomKillDisable: false,
      OomScoreAdj: 0,
      ShmSize: plan.hostConfig.shmSize,
      Init: false,
    },
    Mounts: plan.mounts.map(item => ({
      Type: item.type,
      Source: item.source,
      Destination: item.destination,
      RW: !item.readOnly,
      Propagation: item.propagation,
      Name: '',
    })),
    State: { Status: 'created' },
  }
}

function expectInvalid(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({
    name: 'DockerContainerSelectedProjectionError',
    code: 'DOCKER_CONTAINER_SELECTED_PROJECTION_INVALID',
  } satisfies Partial<DockerContainerSelectedProjectionError>))
}

describe('selected Docker container projection V2', () => {
  it('has exact pre-create/post-inspect hash parity while excluding daemon-generated fields', () => {
    const expectedHash = hashExpectedOwnedDockerContainerProjectionV2(expected())
    const observed = normalizeOwnedDockerContainerInspectProjectionV2(inspect())

    expect(observed).toEqual({
      version: 2,
      resourceKind: 'container',
      sidecarKind: 'lease-bound-docker-bash',
      role: 'worker',
      imageId: IMAGE_ID,
      projectionHash: expectedHash,
    })
    expect(expectedHash).toBe('f169e60cccb30a7d36e7faca5f4bd22b3375714c1faba3b6b5ce9b6d06d7afe2')
    expect(JSON.stringify(observed)).not.toContain('sensitive')
    expect(Object.isFrozen(observed)).toBe(true)
  })

  it.each([
    ['image config ID', (value: Record<string, unknown>) => { value.Image = `sha256:${'d'.repeat(64)}` }],
    ['mount source', (value: Record<string, unknown>) => {
      ((value.Mounts as Record<string, unknown>[])[0]!).Source = '/different'
    }],
    ['command', (value: Record<string, unknown>) => {
      (value.Config as Record<string, unknown>).Cmd = ['-lc', 'different']
    }],
    ['runtime', (value: Record<string, unknown>) => {
      (value.HostConfig as Record<string, unknown>).Runtime = 'runsc'
    }],
  ])('binds security-relevant %s drift into the hash', (_name, mutate) => {
    const changed = inspect()
    mutate(changed)
    expect(normalizeOwnedDockerContainerInspectProjectionV2(changed).projectionHash)
      .not.toBe(hashExpectedOwnedDockerContainerProjectionV2(expected()))
  })

  it('rejects unsafe confinement, missing ownership, unknown Aisy labels and extra mounts', () => {
    const privileged = inspect()
    ;(privileged.HostConfig as Record<string, unknown>).Privileged = true
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(privileged))

    const hostNetwork = inspect()
    ;(hostNetwork.HostConfig as Record<string, unknown>).NetworkMode = 'host'
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(hostNetwork))

    const rootUser = inspect()
    ;(rootUser.Config as Record<string, unknown>).User = '0:0'
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(rootUser))

    const unmasked = inspect()
    ;(unmasked.HostConfig as Record<string, unknown>).MaskedPaths = []
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(unmasked))

    const writableProc = inspect()
    ;(writableProc.HostConfig as Record<string, unknown>).ReadonlyPaths = []
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(writableProc))

    const sysctls = inspect()
    ;(sysctls.HostConfig as Record<string, unknown>).Sysctls = { 'net.ipv4.ip_forward': '1' }
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(sysctls))

    const groups = inspect()
    ;(groups.HostConfig as Record<string, unknown>).GroupAdd = ['0']
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(groups))

    const missingOwnership = inspect()
    delete ((missingOwnership.Config as Record<string, unknown>).Labels as Record<string, string>)[
      'com.aisy.resource.owner'
    ]
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(missingOwnership))

    const unknownOwnership = inspect()
    ;((unknownOwnership.Config as Record<string, unknown>).Labels as Record<string, string>)[
      'com.aisy.unreviewed'
    ] = 'true'
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(unknownOwnership))

    const extraMount = inspect()
    ;(extraMount.Mounts as unknown[]).push({
      Type: 'bind', Source: '/etc', Destination: '/work', RW: true, Propagation: 'rprivate',
    })
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(extraMount))
  })

  it('rejects structural forgery, proxies, symbols and accessors without invoking caller code', () => {
    expectInvalid(() => hashExpectedOwnedDockerContainerProjectionV2({ ...expected(), extra: true }))
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(new Proxy(inspect(), {})))

    const symbol = inspect()
    Object.defineProperty(symbol, Symbol('hidden'), { value: true })
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(symbol))

    let calls = 0
    const accessor = inspect()
    Object.defineProperty(accessor, 'Image', {
      enumerable: true,
      get() { calls += 1; return IMAGE_ID },
    })
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(accessor))
    expect(calls).toBe(0)

    const nestedProxy = inspect()
    ;(nestedProxy.Config as Record<string, unknown>).Healthcheck = new Proxy({ Test: ['NONE'] }, {
      get() { calls += 1; return undefined },
    })
    expectInvalid(() => normalizeOwnedDockerContainerInspectProjectionV2(nestedProxy))
    expect(calls).toBe(0)
  })

  it('does not invoke inherited serialization hooks', () => {
    const beforeObject = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    const beforeArray = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
    let calls = 0
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true, value: () => { calls += 1; return 'changed' },
      })
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true, value: () => { calls += 1; return 'changed' },
      })
      expect(hashExpectedOwnedDockerContainerProjectionV2(expected())).toMatch(/^[a-f0-9]{64}$/)
      expect(normalizeOwnedDockerContainerInspectProjectionV2(inspect()).projectionHash)
        .toMatch(/^[a-f0-9]{64}$/)
      expect(calls).toBe(0)
    } finally {
      if (beforeObject === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON
      else Object.defineProperty(Object.prototype, 'toJSON', beforeObject)
      if (beforeArray === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON
      else Object.defineProperty(Array.prototype, 'toJSON', beforeArray)
    }
  })
})

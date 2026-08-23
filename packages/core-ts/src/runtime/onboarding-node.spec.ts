import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  classifyDockerDaemonFailure,
  detectGlobalInstall,
  inspectNodeMcpAllowlist,
  makeNodeService,
  nodeDockerRequired,
  probeRestrictedCloneSandbox,
  validNightlySchedule,
} from './onboarding-node.js'
import { launchdPlist, systemdUnit } from './service-files.js'

const WORKER = `registry.example/aisy/clone@sha256:${'a'.repeat(64)}`
const GATEWAY = `registry.example/aisy/egress@sha256:${'b'.repeat(64)}`
const serviceRoots: string[] = []

function serviceRoot(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-service-')))
  serviceRoots.push(value)
  return value
}

afterEach(() => {
  for (const path of serviceRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})

function serviceHarness(
  platform: 'linux' | 'darwin',
  response: (
    cmd: string,
    args: string[],
    index: number,
  ) => boolean | { ok: boolean; out: string; message: string } | undefined = () => undefined,
) {
  const root = serviceRoot()
  const homeDir = join(root, 'operator home')
  const aisyHome = join(root, 'aisy data')
  const commands: Array<{ cmd: string; args: string[] }> = []
  const service = makeNodeService({
    platform,
    homeDir,
    execPath: '/opt/Aisy Node/node',
    binPath: '/opt/Aisy CLI/aisy.js',
    aisyHome,
    runCommand: async (cmd, args) => {
      const index = commands.length
      commands.push({ cmd, args: [...args] })
      const injected = response(cmd, args, index)
      if (typeof injected === 'object') return injected
      if (injected === true) return { ok: false, out: '', message: 'injected command failure' }
      if (cmd === 'systemctl' && args[1] === 'is-enabled') {
        const unitPath = join(homeDir, '.config', 'systemd', 'user', 'aisy.service')
        const state = existsSync(unitPath) ? 'disabled' : 'not-found'
        return { ok: false, out: state, message: state }
      }
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        return { ok: false, out: 'inactive', message: 'inactive' }
      }
      if (cmd === 'launchctl' && args[0] === 'list') {
        return { ok: true, out: '-\t0\tcom.aisy.agent', message: '' }
      }
      return { ok: true, out: '', message: '' }
    },
  })
  return { root, homeDir, aisyHome, commands, service }
}

function generatedLinuxUnit(aisyHome: string): string {
  return systemdUnit({
    execPath: '/opt/Aisy Node/node',
    binPath: '/opt/Aisy CLI/aisy.js',
    home: aisyHome,
    logPath: join(aisyHome, 'run.log'),
  })
}

function generatedLaunchdPlist(aisyHome: string): string {
  return launchdPlist({
    execPath: '/opt/Aisy Node/node',
    binPath: '/opt/Aisy CLI/aisy.js',
    home: aisyHome,
    logPath: join(aisyHome, 'run.log'),
  })
}

describe('detectGlobalInstall', () => {
  it('global npm install via a bin symlink — argv[1] is the symlink, realpath is under node_modules', () => {
    // The bug we hit: process.argv[1] is the symlink, NOT under node_modules.
    const binPath = '/opt/homebrew/bin/aisy'
    const binReal = '/opt/homebrew/lib/node_modules/@aisy/app/dist/bin/aisy.js'
    const moduleUrl = 'file:///opt/homebrew/lib/node_modules/@aisy/core/dist/runtime/onboarding-node.js'
    expect(detectGlobalInstall(binPath, binReal, moduleUrl)).toBe(true)
  })

  it('global install where argv[1] already resolves under node_modules', () => {
    const p = '/usr/local/lib/node_modules/@aisy/app/dist/bin/aisy.js'
    expect(detectGlobalInstall(p, p, `file://${p}`)).toBe(true)
  })

  it('source checkout — nothing is under node_modules', () => {
    const binPath = '/Users/iam/Work/Projects/aisy-harness/packages/app/dist/bin/aisy.js'
    const moduleUrl = 'file:///Users/iam/Work/Projects/aisy-harness/packages/core-ts/dist/runtime/onboarding-node.js'
    expect(detectGlobalInstall(binPath, binPath, moduleUrl)).toBe(false)
  })
})

describe('restricted clone Node doctor probe', () => {
  it('does not touch Docker while restricted clone is disabled', () => {
    const calls: string[][] = []
    const result = probeRestrictedCloneSandbox({
      env: {},
      docker: (...args) => { calls.push(args); return null },
    })

    expect(result).toMatchObject({
      enablement: 'disabled',
      serverVersion: null,
      versionCompatible: false,
      workerImagePresent: false,
      gatewayImagePresent: false,
    })
    expect(calls).toEqual([])
  })

  it('proves exact local RepoDigests on a compatible server using read-only commands', () => {
    const calls: string[][] = []
    const result = probeRestrictedCloneSandbox({
      env: {
        AISY_RESTRICTED_CLONE_ENABLED: 'true',
        AISY_RESTRICTED_CLONE_WORKER_IMAGE: WORKER,
        AISY_RESTRICTED_CLONE_GATEWAY_IMAGE: GATEWAY,
      },
      docker: (...args) => {
        calls.push(args)
        if (args[0] === 'version') return '29.6.0\n'
        const reference = args.at(-1)
        return JSON.stringify([reference])
      },
    })

    expect(result).toEqual({
      enablement: 'enabled',
      workerImageReferenceValid: true,
      gatewayImageReferenceValid: true,
      serverVersion: '29.6.0',
      versionCompatible: true,
      workerImagePresent: true,
      gatewayImagePresent: true,
    })
    expect(calls).toEqual([
      ['version', '--format={{.Server.Version}}'],
      ['image', 'inspect', '--format={{json .RepoDigests}}', WORKER],
      ['image', 'inspect', '--format={{json .RepoDigests}}', GATEWAY],
    ])
  })

  it('fails closed for Docker 27, tag references, malformed enablement and forged RepoDigests', () => {
    const old = probeRestrictedCloneSandbox({
      env: {
        AISY_RESTRICTED_CLONE_ENABLED: '1',
        AISY_RESTRICTED_CLONE_WORKER_IMAGE: WORKER,
        AISY_RESTRICTED_CLONE_GATEWAY_IMAGE: GATEWAY,
      },
      docker: (...args) => args[0] === 'version'
        ? '27.4.0'
        : JSON.stringify([args.at(-1)]),
    })
    expect(old).toMatchObject({ versionCompatible: false, serverVersion: '27.4.0' })

    const imageCalls: string[][] = []
    const tag = probeRestrictedCloneSandbox({
      env: {
        AISY_RESTRICTED_CLONE_ENABLED: 'yes',
        AISY_RESTRICTED_CLONE_WORKER_IMAGE: 'registry.example/aisy/clone:latest',
        AISY_RESTRICTED_CLONE_GATEWAY_IMAGE: GATEWAY,
      },
      docker: (...args) => {
        imageCalls.push(args)
        if (args[0] === 'version') return '29.6.0'
        return JSON.stringify(['registry.example/other@sha256:' + 'c'.repeat(64)])
      },
    })
    expect(tag).toMatchObject({
      workerImageReferenceValid: false,
      workerImagePresent: false,
      gatewayImagePresent: false,
    })
    expect(imageCalls.some(args => args.includes('registry.example/aisy/clone:latest'))).toBe(false)

    const invalid = probeRestrictedCloneSandbox({
      env: { AISY_RESTRICTED_CLONE_ENABLED: 'sometimes' },
      docker: () => { throw new Error('must stay read-only and skip Docker') },
    })
    expect(invalid.enablement).toBe('invalid')
  })

  it('rolls back to disabled state without retaining readiness or touching Docker', () => {
    const calls: string[][] = []
    const docker = (...args: string[]): string | null => {
      calls.push(args)
      return args[0] === 'version' ? '29.6.0' : JSON.stringify([args.at(-1)])
    }
    const configured = {
      AISY_RESTRICTED_CLONE_ENABLED: 'true',
      AISY_RESTRICTED_CLONE_WORKER_IMAGE: WORKER,
      AISY_RESTRICTED_CLONE_GATEWAY_IMAGE: GATEWAY,
    }

    expect(probeRestrictedCloneSandbox({ env: configured, docker }).versionCompatible).toBe(true)
    const beforeRollback = calls.length
    const rolledBack = probeRestrictedCloneSandbox({
      env: { ...configured, AISY_RESTRICTED_CLONE_ENABLED: 'false' },
      docker,
    })

    expect(rolledBack).toMatchObject({
      enablement: 'disabled',
      serverVersion: null,
      versionCompatible: false,
      workerImagePresent: false,
      gatewayImagePresent: false,
    })
    expect(calls).toHaveLength(beforeRollback)
  })
})

describe('Docker daemon diagnostics', () => {
  it('distinguishes permission denial, stopped daemon, missing CLI, and unknown failures', () => {
    expect(classifyDockerDaemonFailure({
      code: 'EPERM',
      stderr: 'connect /Users/private/.docker/run/docker.sock: operation not permitted',
    })).toBe('permission-denied')
    expect(classifyDockerDaemonFailure({
      stderr: 'Cannot connect to the Docker daemon. Is the docker daemon running?',
    })).toBe('down')
    expect(classifyDockerDaemonFailure({ code: 'ENOENT', message: 'spawn docker ENOENT' }))
      .toBe('cli-unavailable')
    expect(classifyDockerDaemonFailure({ stderr: '/private/path: opaque failure' })).toBe('unknown')
  })
})

describe('production doctor topology helpers', () => {
  it('requires Docker only for an explicitly enabled Docker-backed path', () => {
    expect(nodeDockerRequired({})).toBe(false)
    expect(nodeDockerRequired({ AISY_RESTRICTED_CLONE_ENABLED: 'false' })).toBe(false)
    expect(nodeDockerRequired({ AISY_SANDBOX_IMAGE: 'image@sha256:digest' })).toBe(true)
    expect(nodeDockerRequired({ AISY_WHISPER_IMAGE: 'image@sha256:digest' })).toBe(true)
    expect(nodeDockerRequired({ AISY_RESTRICTED_CLONE_ENABLED: 'true' })).toBe(true)
    expect(nodeDockerRequired({ AISY_RESTRICTED_CLONE_ENABLED: 'invalid' })).toBe(true)
  })

  it('validates the in-process nightly wall-clock schedule', () => {
    expect(validNightlySchedule(undefined)).toBe(true)
    expect(validNightlySchedule('00:00')).toBe(true)
    expect(validNightlySchedule('23:59')).toBe(true)
    expect(validNightlySchedule('24:00')).toBe(false)
    expect(validNightlySchedule('3:30')).toBe(false)
  })

  it('treats a missing MCP manifest as an empty valid allowlist and rejects malformed bytes', () => {
    const root = serviceRoot()
    const path = join(root, 'mcp-allowlist.json')
    expect(inspectNodeMcpAllowlist(path)).toEqual({ parses: true, hashes: true })

    writeFileSync(path, '{broken', { encoding: 'utf8', mode: 0o600 })
    expect(inspectNodeMcpAllowlist(path)).toEqual({ parses: false, hashes: true })

    writeFileSync(path, JSON.stringify({ schemaVersion: 1, servers: [] }), {
      encoding: 'utf8', mode: 0o600,
    })
    expect(inspectNodeMcpAllowlist(path)).toEqual({ parses: true, hashes: true })
  })
})

describe('Node service composition', () => {
  it('publishes a private Linux supervisor unit through injected commands', async () => {
    const h = serviceHarness('linux')

    await expect(h.service('install')).resolves.toMatchObject({ ok: true })

    const unitDir = join(h.homeDir, '.config', 'systemd', 'user')
    const unitPath = join(unitDir, 'aisy.service')
    const unit = readFileSync(unitPath, 'utf8')
    expect(unit).toContain('"/opt/Aisy Node/node" "/opt/Aisy CLI/aisy.js" supervise')
    expect(unit).not.toContain('AISY_' + 'SUPERVISED')
    expect(statSync(unitDir).mode & 0o777).toBe(0o700)
    expect(statSync(unitPath).mode & 0o777).toBe(0o600)
    expect(readdirSync(unitDir).filter(name => name.includes('.tmp-'))).toEqual([])
    expect(h.commands).toEqual([
      { cmd: 'systemctl', args: ['--user', 'is-enabled', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'is-active', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', '--now', 'aisy.service'] },
    ])
  })

  it('fails before publication when exact previous systemd state is unavailable', async () => {
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-enabled') {
        return { ok: false, out: '', message: 'permission denied' }
      }
      return undefined
    })
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')

    await expect(h.service('install')).resolves.toEqual({
      ok: false,
      message: 'service: systemd state unavailable',
    })
    expect(existsSync(unitPath)).toBe(false)
    expect(h.commands.map(call => call.args[1])).toEqual(['is-enabled', 'is-active'])
  })

  it('fails closed for an enabled active systemd unit without an owned local file', async () => {
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-enabled') {
        return { ok: true, out: 'enabled', message: '' }
      }
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        return { ok: true, out: 'active', message: '' }
      }
      return undefined
    })
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')

    const result = await h.service('install')

    expect(result).toEqual({
      ok: false,
      message: 'service: systemd state conflicts with owned unit file',
    })
    expect(existsSync(unitPath)).toBe(false)
    expect(h.commands).toEqual([
      { cmd: 'systemctl', args: ['--user', 'is-enabled', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'is-active', 'aisy.service'] },
    ])
  })

  it('restores the previous Linux bytes when daemon reload fails', async () => {
    const h = serviceHarness('linux', (_cmd, _args, index) => index === 2)
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    const previous = Buffer.from('previous unit bytes\n\0binary-tail')
    writeFileSync(unitPath, previous, { mode: 0o640 })
    chmodSync(unitPath, 0o640)

    await expect(h.service('install')).resolves.toMatchObject({ ok: false })

    expect(readFileSync(unitPath)).toEqual(previous)
    expect(statSync(unitPath).mode & 0o777).toBe(0o640)
    expect(h.commands).toEqual([
      { cmd: 'systemctl', args: ['--user', 'is-enabled', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'is-active', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
    ])
  })

  it('removes a newly published Linux unit when enable fails', async () => {
    const h = serviceHarness('linux', (_cmd, _args, index) => index === 3)
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    mkdirSync(h.aisyHome, { recursive: true })
    const dataPath = join(h.aisyHome, 'memory.db')
    writeFileSync(dataPath, 'operator data')

    await expect(h.service('install')).resolves.toMatchObject({ ok: false })

    expect(existsSync(unitPath)).toBe(false)
    expect(readFileSync(dataPath, 'utf8')).toBe('operator data')
    expect(h.commands).toEqual([
      { cmd: 'systemctl', args: ['--user', 'is-enabled', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'is-active', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', '--now', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
    ])
  })

  it('restores and reloads the previous plist when launchctl load fails', async () => {
    const h = serviceHarness('darwin', (_cmd, args, index) => args[0] === 'load' && index === 2)
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    const previous = Buffer.from('previous plist bytes\n')
    writeFileSync(plistPath, previous, { mode: 0o600 })

    await expect(h.service('install')).resolves.toMatchObject({ ok: false })

    expect(readFileSync(plistPath)).toEqual(previous)
    expect(statSync(dirname(plistPath)).mode & 0o777).toBe(0o700)
    expect(h.commands.map(call => call.args[0])).toEqual(['list', 'unload', 'load', 'unload', 'load'])
  })

  it('restores a previously enabled and active Linux unit after partial enable failure', async () => {
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-enabled') {
        return { ok: true, out: 'enabled', message: '' }
      }
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        return { ok: true, out: 'active', message: '' }
      }
      return cmd === 'systemctl' && args[1] === 'enable' && args[2] === '--now'
    })
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    const previous = Buffer.from('previous active unit\n')
    writeFileSync(unitPath, previous, { mode: 0o640 })

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).not.toContain('rollback failed')
    expect(readFileSync(unitPath)).toEqual(previous)
    expect(statSync(unitPath).mode & 0o777).toBe(0o640)
    expect(h.commands.slice(-4)).toEqual([
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'start', 'aisy.service'] },
    ])
  })

  it('restores a previously disabled and inactive Linux unit after partial enable failure', async () => {
    const h = serviceHarness('linux', (cmd, args) =>
      cmd === 'systemctl' && args[1] === 'enable' && args[2] === '--now')
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    const previous = Buffer.from('previous inactive unit\n')
    writeFileSync(unitPath, previous, { mode: 0o600 })

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).not.toContain('rollback failed')
    expect(readFileSync(unitPath)).toEqual(previous)
    expect(h.commands.slice(-4)).toEqual([
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'disable', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'stop', 'aisy.service'] },
    ])
  })

  it.each([
    ['new-job disable', 4],
    ['rollback daemon reload', 5],
  ])('surfaces Linux rollback command failure: %s', async (_case, failedIndex) => {
    const h = serviceHarness('linux', (_cmd, _args, index) => index === 3 || index === failedIndex)

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('rollback failed')
    expect(existsSync(join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service'))).toBe(false)
  })

  it('surfaces failure while restoring the previous Linux active state', async () => {
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-enabled') {
        return { ok: true, out: 'enabled', message: '' }
      }
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        return { ok: true, out: 'active', message: '' }
      }
      return cmd === 'systemctl' &&
        ((args[1] === 'enable' && args[2] === '--now') || args[1] === 'start')
    })
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(unitPath, 'previous active unit\n', { mode: 0o600 })

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('rollback failed')
    expect(h.commands.at(-1)).toEqual({
      cmd: 'systemctl',
      args: ['--user', 'start', 'aisy.service'],
    })
  })

  it('does not reload a previously inactive launchd job after new load failure', async () => {
    const h = serviceHarness('darwin', (cmd, args) => {
      if (cmd === 'launchctl' && args[0] === 'list') {
        return { ok: true, out: '', message: '' }
      }
      return cmd === 'launchctl' && args[0] === 'load'
    })
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    const previous = Buffer.from('previous inactive plist\n')
    writeFileSync(plistPath, previous, { mode: 0o600 })

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).not.toContain('rollback failed')
    expect(readFileSync(plistPath)).toEqual(previous)
    expect(h.commands.map(call => call.args[0])).toEqual(['list', 'load', 'unload'])
  })

  it('does not treat a launchd label prefix as the exact prior job', async () => {
    const h = serviceHarness('darwin', (cmd, args) => {
      if (cmd === 'launchctl' && args[0] === 'list') {
        return { ok: true, out: '-\t0\tcom.aisy.agent.helper', message: '' }
      }
      return cmd === 'launchctl' && args[0] === 'load'
    })
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, 'previous plist\n', { mode: 0o600 })

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).not.toContain('rollback failed')
    expect(h.commands.map(call => call.args[0])).toEqual(['list', 'load', 'unload'])
  })

  it('fails before publication when previous launchd loaded state is unavailable', async () => {
    const h = serviceHarness('darwin', (cmd, args) =>
      cmd === 'launchctl' && args[0] === 'list')
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    const previous = Buffer.from('previous plist\n')
    writeFileSync(plistPath, previous, { mode: 0o600 })

    await expect(h.service('install')).resolves.toEqual({
      ok: false,
      message: 'service: launchctl state unavailable',
    })
    expect(readFileSync(plistPath)).toEqual(previous)
    expect(h.commands).toEqual([{ cmd: 'launchctl', args: ['list'] }])
  })

  it('surfaces launchd rollback unload failure without reloading an inactive prior job', async () => {
    const h = serviceHarness('darwin', (cmd, args, index) => {
      if (cmd === 'launchctl' && args[0] === 'list') {
        return { ok: true, out: '', message: '' }
      }
      return (args[0] === 'load' && index === 1) || args[0] === 'unload'
    })
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, 'previous plist\n', { mode: 0o600 })

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('rollback failed')
    expect(h.commands.map(call => call.args[0])).toEqual(['list', 'load', 'unload'])
  })

  it('surfaces failure while reloading a previously loaded launchd job', async () => {
    const h = serviceHarness('darwin', (_cmd, args, index) =>
      args[0] === 'load' && (index === 2 || index === 4))
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, 'previous loaded plist\n', { mode: 0o600 })

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('rollback failed')
    expect(h.commands.map(call => call.args[0])).toEqual(['list', 'unload', 'load', 'unload', 'load'])
  })

  it('refuses an existing service-file symlink without touching its target', async () => {
    const h = serviceHarness('linux')
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    const target = join(h.root, 'target-unit')
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(target, 'target bytes\n', { mode: 0o600 })
    symlinkSync(target, unitPath)

    await expect(h.service('install')).resolves.toMatchObject({
      ok: false,
      message: 'service: existing unit file is unsafe',
    })
    expect(readFileSync(target, 'utf8')).toBe('target bytes\n')
    expect(h.commands).toEqual([])
  })

  it.each([
    ['linux', 'stop'],
    ['linux', 'uninstall'],
    ['darwin', 'stop'],
    ['darwin', 'uninstall'],
  ] as const)('refuses %s %s for exact generated bytes with mode 0644 and zero commands', async (
    platform,
    action,
  ) => {
    const h = serviceHarness(platform)
    const path = platform === 'linux'
      ? join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
      : join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    const content = platform === 'linux'
      ? generatedLinuxUnit(h.aisyHome)
      : generatedLaunchdPlist(h.aisyHome)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, { mode: 0o644 })

    await expect(h.service(action)).resolves.toMatchObject({ ok: false })
    expect(readFileSync(path, 'utf8')).toBe(content)
    expect(h.commands).toEqual([])
  })

  it('refuses a symlinked service directory without publishing through it', async () => {
    const h = serviceHarness('linux')
    const targetDir = join(h.root, 'target-service-dir')
    const unitDir = join(h.homeDir, '.config', 'systemd', 'user')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(dirname(unitDir), { recursive: true })
    symlinkSync(targetDir, unitDir)

    await expect(h.service('install')).resolves.toMatchObject({ ok: false })
    expect(existsSync(join(targetDir, 'aisy.service'))).toBe(false)
    expect(h.commands).toEqual([])
  })

  it('fails closed when the service directory is swapped to a symlink after snapshot', async () => {
    let swapped = false
    let unitDirToSwap = ''
    let originalDir = ''
    let attackerDir = ''
    const h = serviceHarness('linux', (cmd, args) => {
      if (!swapped && cmd === 'systemctl' && args[1] === 'is-enabled') {
        mkdirSync(attackerDir, { recursive: true })
        renameSync(unitDirToSwap, originalDir)
        symlinkSync(attackerDir, unitDirToSwap)
        swapped = true
        return { ok: false, out: 'disabled', message: 'disabled' }
      }
      return undefined
    })
    unitDirToSwap = join(h.homeDir, '.config', 'systemd', 'user')
    originalDir = join(h.root, 'original-service-dir')
    attackerDir = join(h.root, 'attacker-service-dir')
    const unitPath = join(unitDirToSwap, 'aisy.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(unitPath, 'previous unit\n', { mode: 0o600 })

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('rollback failed')
    expect(existsSync(join(h.root, 'attacker-service-dir', 'aisy.service'))).toBe(false)
    expect(readFileSync(join(h.root, 'original-service-dir', 'aisy.service'), 'utf8'))
      .toBe('previous unit\n')
  })

  it('refuses uninstall through a symlinked service directory before disabling anything', async () => {
    const h = serviceHarness('linux')
    const targetDir = join(h.root, 'uninstall-target-dir')
    const unitDir = join(h.homeDir, '.config', 'systemd', 'user')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(dirname(unitDir), { recursive: true })
    writeFileSync(join(targetDir, 'aisy.service'), 'target unit\n', { mode: 0o600 })
    symlinkSync(targetDir, unitDir)

    await expect(h.service('uninstall')).resolves.toEqual({
      ok: false,
      message: 'service: owned systemd unit is unsafe or does not match Aisy',
    })
    expect(readFileSync(join(targetDir, 'aisy.service'), 'utf8')).toBe('target unit\n')
    expect(h.commands).toEqual([])
  })

  it('refuses an uninstall service-file symlink before disabling anything', async () => {
    const h = serviceHarness('linux')
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    const target = join(h.root, 'uninstall-target-unit')
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(target, 'target unit\n', { mode: 0o600 })
    symlinkSync(target, unitPath)

    await expect(h.service('uninstall')).resolves.toEqual({
      ok: false,
      message: 'service: owned systemd unit is unsafe or does not match Aisy',
    })
    expect(readFileSync(target, 'utf8')).toBe('target unit\n')
    expect(h.commands).toEqual([])
  })

  it('holds directory identity across disable and refuses an uninstall symlink swap', async () => {
    let unitDirToSwap = ''
    let originalDir = ''
    let attackerDir = ''
    let swapped = false
    let uninstalling = false
    const h = serviceHarness('linux', (cmd, args) => {
      if (uninstalling && cmd === 'systemctl' && args[1] === 'is-enabled') {
        return { ok: true, out: 'enabled', message: 'enabled' }
      }
      if (uninstalling && cmd === 'systemctl' && args[1] === 'is-active') {
        return { ok: true, out: 'active', message: 'active' }
      }
      if (!swapped && cmd === 'systemctl' && args[1] === 'disable' && args[2] === '--now') {
        mkdirSync(attackerDir, { recursive: true })
        writeFileSync(join(attackerDir, 'aisy.service'), 'attacker unit\n', { mode: 0o600 })
        renameSync(unitDirToSwap, originalDir)
        symlinkSync(attackerDir, unitDirToSwap)
        swapped = true
      }
      return undefined
    })
    unitDirToSwap = join(h.homeDir, '.config', 'systemd', 'user')
    originalDir = join(h.root, 'uninstall-original-dir')
    attackerDir = join(h.root, 'uninstall-attacker-dir')
    await h.service('install')
    h.commands.splice(0)
    uninstalling = true

    await expect(h.service('uninstall')).resolves.toEqual({
      ok: false,
      message: 'service: unit file changed before removal',
    })
    expect(readFileSync(join(originalDir, 'aisy.service'), 'utf8')).toContain('ExecStart=')
    expect(readFileSync(join(attackerDir, 'aisy.service'), 'utf8')).toBe('attacker unit\n')
    expect(h.commands).toEqual([
      { cmd: 'systemctl', args: ['--user', 'is-enabled', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'is-active', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', 'aisy.service'] },
    ])
  })

  it('uninstalls only service composition and preserves AISY_HOME data', async () => {
    const h = serviceHarness('linux')
    mkdirSync(h.aisyHome, { recursive: true })
    const dataPath = join(h.aisyHome, 'memory.db')
    writeFileSync(dataPath, 'operator data')
    await h.service('install')
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')

    await expect(h.service('uninstall')).resolves.toMatchObject({ ok: true })

    expect(existsSync(unitPath)).toBe(false)
    expect(readFileSync(dataPath, 'utf8')).toBe('operator data')
  })

  it.each(['static', 'indirect', 'masked', 'generated', 'transient'])(
    'fails closed for unsupported exact systemd enablement state %s',
    async (state) => {
      const h = serviceHarness('linux', (cmd, args) => {
        if (cmd === 'systemctl' && args[1] === 'is-enabled') {
          return { ok: false, out: state, message: state }
        }
        return undefined
      })
      const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')

      await expect(h.service('install')).resolves.toEqual({
        ok: false,
        message: 'service: systemd state unavailable',
      })
      expect(existsSync(unitPath)).toBe(false)
      expect(h.commands).toHaveLength(2)
    },
  )

  it('restores enabled-runtime exactly after a partial Linux activation failure', async () => {
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-enabled') {
        return { ok: true, out: 'enabled-runtime', message: '' }
      }
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        return { ok: true, out: 'active', message: '' }
      }
      return cmd === 'systemctl' && args[1] === 'enable' && args[2] === '--now'
    })
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(unitPath, 'previous runtime-enabled unit\n', { mode: 0o600 })

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).not.toContain('rollback failed')
    expect(readFileSync(unitPath, 'utf8')).toBe('previous runtime-enabled unit\n')
    expect(h.commands.slice(-4)).toEqual([
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', '--runtime', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'start', 'aisy.service'] },
    ])
  })

  it.each([
    ['disabled', 'inactive'],
    ['enabled', 'inactive'],
  ])('rejects systemd state %s/%s without an owned local file', async (enabled, active) => {
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-enabled') {
        return { ok: enabled === 'enabled', out: enabled, message: enabled }
      }
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        return { ok: active === 'active', out: active, message: active }
      }
      return undefined
    })

    await expect(h.service('install')).resolves.toEqual({
      ok: false,
      message: 'service: systemd state conflicts with owned unit file',
    })
  })

  it('rejects not-found systemd state when an owned unit file exists', async () => {
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-enabled') {
        return { ok: false, out: 'not-found', message: 'not-found' }
      }
      return undefined
    })
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(unitPath, 'owned unit\n', { mode: 0o600 })

    await expect(h.service('install')).resolves.toEqual({
      ok: false,
      message: 'service: systemd state conflicts with owned unit file',
    })
    expect(readFileSync(unitPath, 'utf8')).toBe('owned unit\n')
  })

  it('checks launchctl before publication and rejects a loaded label without an owned plist', async () => {
    const h = serviceHarness('darwin')
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')

    await expect(h.service('install')).resolves.toEqual({
      ok: false,
      message: 'service: loaded launchd job has no owned plist',
    })
    expect(existsSync(plistPath)).toBe(false)
    expect(h.commands).toEqual([{ cmd: 'launchctl', args: ['list'] }])
  })

  it('checks launchctl before publishing and loading a new plist', async () => {
    const h = serviceHarness('darwin', (cmd, args) => {
      if (cmd === 'launchctl' && args[0] === 'list') {
        return { ok: true, out: '', message: '' }
      }
      return undefined
    })
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')

    await expect(h.service('install')).resolves.toMatchObject({ ok: true })

    expect(readFileSync(plistPath, 'utf8')).toContain('<key>KeepAlive</key>')
    expect(h.commands).toEqual([
      { cmd: 'launchctl', args: ['list'] },
      { cmd: 'launchctl', args: ['load', '-w', plistPath] },
    ])
  })

  it('fails before new-plist publication when launchctl state is unavailable', async () => {
    const h = serviceHarness('darwin', (cmd, args) =>
      cmd === 'launchctl' && args[0] === 'list')
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')

    await expect(h.service('install')).resolves.toEqual({
      ok: false,
      message: 'service: launchctl state unavailable',
    })
    expect(existsSync(plistPath)).toBe(false)
    expect(h.commands).toEqual([{ cmd: 'launchctl', args: ['list'] }])
  })

  it('preserves the Linux unit when disable fails', async () => {
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-enabled') {
        return { ok: true, out: 'enabled', message: 'enabled' }
      }
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        return { ok: true, out: 'active', message: 'active' }
      }
      return cmd === 'systemctl' && args[1] === 'disable' && args[2] === '--now'
    })
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    const unit = generatedLinuxUnit(h.aisyHome)
    writeFileSync(unitPath, unit, { mode: 0o600 })

    const result = await h.service('uninstall')

    expect(result).toMatchObject({ ok: false })
    expect(readFileSync(unitPath, 'utf8')).toBe(unit)
    expect(h.commands).toEqual([
      { cmd: 'systemctl', args: ['--user', 'is-enabled', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'is-active', 'aisy.service'] },
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', 'aisy.service'] },
    ])
  })

  it('preserves the launchd plist when unload fails', async () => {
    const h = serviceHarness('darwin', (cmd, args) =>
      cmd === 'launchctl' && args[0] === 'unload')
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    const plist = generatedLaunchdPlist(h.aisyHome)
    writeFileSync(plistPath, plist, { mode: 0o600 })

    const result = await h.service('uninstall')

    expect(result).toMatchObject({ ok: false })
    expect(readFileSync(plistPath, 'utf8')).toBe(plist)
    expect(h.commands).toEqual([
      { cmd: 'launchctl', args: ['list'] },
      { cmd: 'launchctl', args: ['unload', plistPath] },
    ])
  })

  it('removes an owned launchd plist idempotently when the job is already stopped', async () => {
    const h = serviceHarness('darwin', (cmd, args) => {
      if (cmd === 'launchctl' && args[0] === 'list') {
        return { ok: true, out: '', message: '' }
      }
      return undefined
    })
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, generatedLaunchdPlist(h.aisyHome), { mode: 0o600 })

    await expect(h.service('uninstall')).resolves.toMatchObject({ ok: true })

    expect(existsSync(plistPath)).toBe(false)
    expect(h.commands).toEqual([{ cmd: 'launchctl', args: ['list'] }])
  })

  it('rejects a symlink in an intermediate service-directory component', async () => {
    const h = serviceHarness('linux')
    const target = join(h.root, 'attacker-config')
    mkdirSync(target, { recursive: true })
    mkdirSync(h.homeDir, { recursive: true })
    symlinkSync(target, join(h.homeDir, '.config'))

    await expect(h.service('install')).resolves.toMatchObject({ ok: false })
    expect(existsSync(join(target, 'systemd', 'user', 'aisy.service'))).toBe(false)
    expect(h.commands).toEqual([])
  })

  it('rejects uninstall through an intermediate symlink even when the target file is absent', async () => {
    const h = serviceHarness('linux')
    const target = join(h.root, 'empty-config')
    mkdirSync(target, { recursive: true })
    mkdirSync(h.homeDir, { recursive: true })
    symlinkSync(target, join(h.homeDir, '.config'))

    await expect(h.service('uninstall')).resolves.toEqual({
      ok: false,
      message: 'service: owned systemd unit is unsafe or does not match Aisy',
    })
    expect(h.commands).toEqual([])
  })

  it('rejects a symlinked trusted home root', async () => {
    const h = serviceHarness('linux')
    const target = join(h.root, 'attacker-home')
    mkdirSync(target, { recursive: true })
    symlinkSync(target, h.homeDir)

    await expect(h.service('install')).resolves.toMatchObject({ ok: false })
    expect(existsSync(join(target, '.config', 'systemd', 'user', 'aisy.service'))).toBe(false)
    expect(h.commands).toEqual([])
  })

  it('rejects a symlink in an ancestor of the trusted home root', async () => {
    const root = serviceRoot()
    const targetParent = join(root, 'target-parent')
    const linkedParent = join(root, 'linked-parent')
    mkdirSync(targetParent, { recursive: true })
    symlinkSync(targetParent, linkedParent)
    const commands: Array<{ cmd: string; args: string[] }> = []
    const service = makeNodeService({
      platform: 'linux',
      homeDir: join(linkedParent, 'operator-home'),
      execPath: '/opt/node',
      binPath: '/opt/aisy',
      aisyHome: join(root, 'aisy-data'),
      runCommand: async (cmd, args) => {
        commands.push({ cmd, args: [...args] })
        return { ok: true, out: '', message: '' }
      },
    })

    await expect(service('install')).resolves.toMatchObject({ ok: false })
    expect(existsSync(join(targetParent, 'operator-home', '.config'))).toBe(false)
    expect(commands).toEqual([])
  })

  it('does not overwrite a concurrent target created after an absent snapshot', async () => {
    let unitPath = ''
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        writeFileSync(unitPath, 'concurrent unit\n', { mode: 0o600 })
      }
      return undefined
    })
    unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('rollback failed')
    expect(readFileSync(unitPath, 'utf8')).toBe('concurrent unit\n')
  })

  it('does not overwrite a concurrent replacement created after an existing snapshot', async () => {
    let unitPath = ''
    let backup = ''
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        renameSync(unitPath, backup)
        writeFileSync(unitPath, 'concurrent replacement\n', { mode: 0o600 })
      }
      return undefined
    })
    unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    backup = join(h.root, 'original-unit')
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(unitPath, 'original unit\n', { mode: 0o600 })

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('rollback failed')
    expect(readFileSync(unitPath, 'utf8')).toBe('concurrent replacement\n')
    expect(readFileSync(backup, 'utf8')).toBe('original unit\n')
  })

  it('does not delete a concurrent replacement during install rollback', async () => {
    let unitPath = ''
    let published = ''
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'daemon-reload' && published === '') {
        published = join(h.root, 'published-unit')
        renameSync(unitPath, published)
        writeFileSync(unitPath, 'concurrent replacement\n', { mode: 0o600 })
        return true
      }
      return undefined
    })
    unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')

    const result = await h.service('install')

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('rollback failed')
    expect(readFileSync(unitPath, 'utf8')).toBe('concurrent replacement\n')
    expect(readFileSync(published, 'utf8')).toContain('ExecStart=')
  })

  it('uses unload/load by exact plist path for launchd stop, start and restart', async () => {
    const h = serviceHarness('darwin')
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, generatedLaunchdPlist(h.aisyHome), { mode: 0o600 })

    await expect(h.service('stop')).resolves.toMatchObject({ ok: true })
    await expect(h.service('start')).resolves.toMatchObject({ ok: true })
    await expect(h.service('restart')).resolves.toMatchObject({ ok: true })

    expect(h.commands).toEqual([
      { cmd: 'launchctl', args: ['list'] },
      { cmd: 'launchctl', args: ['unload', plistPath] },
      { cmd: 'launchctl', args: ['load', '-w', plistPath] },
      { cmd: 'launchctl', args: ['unload', plistPath] },
      { cmd: 'launchctl', args: ['load', '-w', plistPath] },
    ])
  })

  it('refuses launchd lifecycle actions for an unsafe plist', async () => {
    const h = serviceHarness('darwin')
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    const target = join(h.root, 'foreign-plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(target, 'foreign bytes\n', { mode: 0o600 })
    symlinkSync(target, plistPath)

    await expect(h.service('stop')).resolves.toEqual({
      ok: false,
      message: 'service: owned launchd plist is unsafe or does not match Aisy',
    })
    expect(readFileSync(target, 'utf8')).toBe('foreign bytes\n')
    expect(h.commands).toEqual([])
  })

  it.each(['start', 'restart'] as const)(
    'refuses Linux %s for a tampered same-owner unit without invoking systemctl',
    async (action) => {
      const h = serviceHarness('linux')
      const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
      mkdirSync(dirname(unitPath), { recursive: true })
      writeFileSync(unitPath, 'tampered unit\n', { mode: 0o600 })

      await expect(h.service(action)).resolves.toMatchObject({ ok: false })
      expect(h.commands).toEqual([])
    },
  )

  it('refuses Linux start when exact generated bytes are not private 0600', async () => {
    const h = serviceHarness('linux')
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(unitPath, systemdUnit({
      execPath: '/opt/Aisy Node/node',
      binPath: '/opt/Aisy CLI/aisy.js',
      home: h.aisyHome,
      logPath: join(h.aisyHome, 'run.log'),
    }), { mode: 0o644 })

    await expect(h.service('start')).resolves.toMatchObject({ ok: false })
    expect(h.commands).toEqual([])
  })

  it.each(['start', 'restart'] as const)(
    'refuses launchd %s for a tampered same-owner plist without loading it',
    async (action) => {
      const h = serviceHarness('darwin')
      const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
      mkdirSync(dirname(plistPath), { recursive: true })
      writeFileSync(plistPath, 'tampered plist\n', { mode: 0o600 })

      await expect(h.service(action)).resolves.toMatchObject({ ok: false })
      expect(h.commands).toEqual([])
    },
  )

  it('refuses launchd start when exact generated bytes are not private 0600', async () => {
    const h = serviceHarness('darwin')
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, launchdPlist({
      execPath: '/opt/Aisy Node/node',
      binPath: '/opt/Aisy CLI/aisy.js',
      home: h.aisyHome,
      logPath: join(h.aisyHome, 'run.log'),
    }), { mode: 0o644 })

    await expect(h.service('start')).resolves.toMatchObject({ ok: false })
    expect(h.commands).toEqual([])
  })

  it.each([
    ['linux', 'stop'],
    ['linux', 'uninstall'],
    ['darwin', 'stop'],
    ['darwin', 'uninstall'],
  ] as const)('refuses %s %s for tampered same-owner service bytes with zero commands', async (
    platform,
    action,
  ) => {
    const h = serviceHarness(platform)
    const path = platform === 'linux'
      ? join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
      : join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'same-owner but not generated by Aisy\n', { mode: 0o600 })

    await expect(h.service(action)).resolves.toMatchObject({ ok: false })
    expect(readFileSync(path, 'utf8')).toBe('same-owner but not generated by Aisy\n')
    expect(h.commands).toEqual([])
  })

  it('makes repeated Linux stop idempotent after the first exact deactivation', async () => {
    let active = true
    const h = serviceHarness('linux', (cmd, args) => {
      if (cmd === 'systemctl' && args[1] === 'is-enabled') {
        return { ok: true, out: 'enabled', message: 'enabled' }
      }
      if (cmd === 'systemctl' && args[1] === 'is-active') {
        const state = active ? 'active' : 'inactive'
        return { ok: active, out: state, message: state }
      }
      if (cmd === 'systemctl' && args[1] === 'stop') active = false
      return undefined
    })
    const unitPath = join(h.homeDir, '.config', 'systemd', 'user', 'aisy.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(unitPath, generatedLinuxUnit(h.aisyHome), { mode: 0o600 })

    await expect(h.service('stop')).resolves.toMatchObject({ ok: true })
    const beforeSecond = h.commands.length
    await expect(h.service('stop')).resolves.toMatchObject({ ok: true })

    expect(h.commands.filter(call => call.args[1] === 'stop')).toHaveLength(1)
    expect(h.commands.slice(beforeSecond).map(call => call.args[1])).toEqual(['is-enabled', 'is-active'])
  })

  it('makes repeated Linux uninstall idempotent without a second destructive command', async () => {
    const h = serviceHarness('linux')
    await expect(h.service('install')).resolves.toMatchObject({ ok: true })
    h.commands.splice(0)

    await expect(h.service('uninstall')).resolves.toMatchObject({ ok: true })
    const beforeSecond = h.commands.length
    await expect(h.service('uninstall')).resolves.toMatchObject({ ok: true })

    expect(h.commands.slice(beforeSecond).map(call => call.args[1])).toEqual(['is-enabled', 'is-active'])
  })

  it('makes repeated launchd stop idempotent after one exact unload', async () => {
    let loaded = true
    const h = serviceHarness('darwin', (cmd, args) => {
      if (cmd === 'launchctl' && args[0] === 'list') {
        return { ok: true, out: loaded ? '-\t0\tcom.aisy.agent' : '', message: '' }
      }
      if (cmd === 'launchctl' && args[0] === 'unload') loaded = false
      return undefined
    })
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, generatedLaunchdPlist(h.aisyHome), { mode: 0o600 })

    await expect(h.service('stop')).resolves.toMatchObject({ ok: true })
    const beforeSecond = h.commands.length
    await expect(h.service('stop')).resolves.toMatchObject({ ok: true })

    expect(h.commands.filter(call => call.args[0] === 'unload')).toHaveLength(1)
    expect(h.commands.slice(beforeSecond)).toEqual([{ cmd: 'launchctl', args: ['list'] }])
  })

  it('makes repeated launchd uninstall idempotent without a second unload', async () => {
    let loaded = true
    const h = serviceHarness('darwin', (cmd, args) => {
      if (cmd === 'launchctl' && args[0] === 'list') {
        return { ok: true, out: loaded ? '-\t0\tcom.aisy.agent' : '', message: '' }
      }
      if (cmd === 'launchctl' && args[0] === 'unload') loaded = false
      return undefined
    })
    const plistPath = join(h.homeDir, 'Library', 'LaunchAgents', 'com.aisy.agent.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, generatedLaunchdPlist(h.aisyHome), { mode: 0o600 })

    await expect(h.service('uninstall')).resolves.toMatchObject({ ok: true })
    const beforeSecond = h.commands.length
    await expect(h.service('uninstall')).resolves.toMatchObject({ ok: true })

    expect(h.commands.filter(call => call.args[0] === 'unload')).toHaveLength(1)
    expect(h.commands.slice(beforeSecond)).toEqual([{ cmd: 'launchctl', args: ['list'] }])
  })

  it.each(['stop', 'uninstall'] as const)(
    'fails closed for Linux %s when systemd is active without an exact owned unit',
    async (action) => {
      const h = serviceHarness('linux', (cmd, args) => {
        if (cmd === 'systemctl' && args[1] === 'is-enabled') {
          return { ok: true, out: 'enabled', message: 'enabled' }
        }
        if (cmd === 'systemctl' && args[1] === 'is-active') {
          return { ok: true, out: 'active', message: 'active' }
        }
        return undefined
      })

      await expect(h.service(action)).resolves.toMatchObject({ ok: false })
      expect(h.commands.map(call => call.args[1])).toEqual(['is-enabled', 'is-active'])
    },
  )

  it.each(['stop', 'uninstall'] as const)(
    'fails closed for launchd %s when the label is loaded without an exact owned plist',
    async (action) => {
      const h = serviceHarness('darwin')

      await expect(h.service(action)).resolves.toMatchObject({ ok: false })
      expect(h.commands).toEqual([{ cmd: 'launchctl', args: ['list'] }])
    },
  )
})

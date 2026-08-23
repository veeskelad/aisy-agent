import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { OWNED_DOCKER_PARENT_BROKER_REQUIRED } from './execution-docker-startup-policy.js'
import { makeDockerRecoveryActivationTestFixture } from './__test_support__/docker-recovery-activation.js'
import { OWNED_DOCKER_LEDGER_FILENAME } from './execution-owned-docker-resources.js'
import { resolveExecutionSupervisorStateRoot } from './supervisor-state.js'
import {
  enrollNodeOwnedDockerProductionRecovery,
  OWNED_DOCKER_PRODUCTION_CONFIG_INVALID,
  OWNED_DOCKER_SUPERVISOR_REQUIRED,
} from './owned-docker-production-recovery.js'

const sourceRoot = dirname(fileURLToPath(import.meta.url))
const loader = join(sourceRoot, '..', 'test-fixtures', 'typescript-source-loader.mjs')
const bin = join(sourceRoot, 'bin', 'aisy.ts')

function spawnCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Readonly<{
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 10_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error('CLI_TIMEOUT'))
      else resolve(Object.freeze({ status, signal, stdout, stderr }))
    })
  })
}

describe('execution Docker CLI startup refusal', () => {
  it.each([
    ['supervise', { AISY_SANDBOX_IMAGE: 'legacy-bash-image' }],
    ['run', { AISY_WHISPER_IMAGE: 'legacy-whisper-image' }],
    ['run', { AISY_RESTRICTED_CLONE_ENABLED: 'true' }],
  ] as const)('refuses %s before runtime state or external startup I/O', (command, activation) => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-docker-startup-refusal-'))
    const stateRoot = join(root, 'state')
    const aisyRoot = join(root, 'aisy')
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--experimental-loader', loader,
        bin,
        command,
      ], {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: root,
          XDG_STATE_HOME: stateRoot,
          AISY_HOME: aisyRoot,
          ...activation,
        },
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(70)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`aisy: ${OWNED_DOCKER_PARENT_BROKER_REQUIRED}\n`)
      expect(existsSync(stateRoot)).toBe(false)
      expect(existsSync(aisyRoot)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps doctor outside the run/supervise activation guard', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-docker-doctor-'))
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--experimental-loader', loader,
        bin,
        'doctor',
      ], {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: root,
          AISY_HOME: join(root, 'aisy'),
          AISY_SANDBOX_IMAGE: 'legacy-image-is-data-for-doctor',
        },
      })

      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(70)
      expect(result.stderr).not.toContain(OWNED_DOCKER_PARENT_BROKER_REQUIRED)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    [{ AISY_OWNED_DOCKER_RECOVERY: '1' }, OWNED_DOCKER_PRODUCTION_CONFIG_INVALID],
    [{
      AISY_OWNED_DOCKER_RECOVERY: '1',
      AISY_OWNED_DOCKER_SOCKET: '/run/docker.sock',
      AISY_OWNED_DOCKER_INSTALLATION_ID: 'a'.repeat(64),
      AISY_OWNED_DOCKER_SERVER_ID: 'daemon-one',
      AISY_OWNED_DOCKER_SERVER_VERSION: '29.5.2',
    }, OWNED_DOCKER_SUPERVISOR_REQUIRED],
  ] as const)('refuses direct run with parent-only config as %s', (activation, code) => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-docker-parent-only-'))
    const stateRoot = join(root, 'state')
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--experimental-loader', loader,
        bin,
        'run',
      ], {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: root,
          XDG_STATE_HOME: stateRoot,
          AISY_HOME: join(root, 'aisy'),
          ...activation,
        },
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(70)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`aisy: ${code}\n`)
      expect(existsSync(stateRoot)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('performs explicit Docker recovery enrollment without starting a child', async () => {
    const fixture = await makeDockerRecoveryActivationTestFixture()
    const root = mkdtempSync(join(tmpdir(), 'aisy-docker-enroll-'))
    const stateRoot = join(root, 'state')
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--experimental-loader', loader,
        bin,
        'docker',
        'enroll',
      ], {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: root,
          XDG_STATE_HOME: stateRoot,
          AISY_OWNED_DOCKER_RECOVERY: '1',
          AISY_OWNED_DOCKER_SOCKET: fixture.socketPath,
          AISY_OWNED_DOCKER_INSTALLATION_ID: 'b'.repeat(64),
          AISY_OWNED_DOCKER_SERVER_ID: fixture.endpointIdentity.serverId,
          AISY_OWNED_DOCKER_SERVER_VERSION: fixture.endpointIdentity.serverVersion,
        },
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('Aisy: Docker recovery enrollment completed.\n')
      expect(result.stderr).toBe('')
      const resolved = resolveExecutionSupervisorStateRoot({
        platform: process.platform,
        home: root,
        xdgStateHome: stateRoot,
      })
      expect(existsSync(join(resolved, 'owned-docker-v4', OWNED_DOCKER_LEDGER_FILENAME)))
        .toBe(true)
    } finally {
      await fixture.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports an enrolled pinned recovery barrier through read-only doctor', async () => {
    const fixture = await makeDockerRecoveryActivationTestFixture()
    const root = mkdtempSync(join(tmpdir(), 'aisy-docker-doctor-ready-'))
    const stateRoot = join(root, 'state')
    const activation = {
      AISY_OWNED_DOCKER_RECOVERY: '1',
      AISY_OWNED_DOCKER_SOCKET: fixture.socketPath,
      AISY_OWNED_DOCKER_INSTALLATION_ID: 'c'.repeat(64),
      AISY_OWNED_DOCKER_SERVER_ID: fixture.endpointIdentity.serverId,
      AISY_OWNED_DOCKER_SERVER_VERSION: fixture.endpointIdentity.serverVersion,
    }
    try {
      const resolved = resolveExecutionSupervisorStateRoot({
        platform: process.platform,
        home: root,
        xdgStateHome: stateRoot,
      })
      enrollNodeOwnedDockerProductionRecovery({ source: activation, stateRoot: resolved })
      const result = await spawnCli([
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--experimental-loader', loader,
        bin,
        'doctor',
        '--only=sidecars',
        '--json',
      ], {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: root,
        XDG_STATE_HOME: stateRoot,
        AISY_HOME: join(root, 'aisy'),
        ...activation,
      })

      expect(result.signal).toBeNull()
      const report = JSON.parse(result.stdout) as {
        checks?: Array<{ id?: string; status?: string; detail?: string }>
      }
      expect(report.checks?.find(check => check.id === 'sidecars.owned-docker-recovery'))
        .toEqual(expect.objectContaining({
          status: 'pass',
          detail: 'Parent Docker recovery: config, ledger и pinned daemon готовы',
        }))
      expect(result.stderr).toBe('')
    } finally {
      await fixture.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not enroll when the exact Docker command has trailing arguments', () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-docker-enroll-extra-'))
    const stateRoot = join(root, 'state')
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--experimental-loader', loader,
        bin,
        'docker',
        'enroll',
        'unexpected',
      ], {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: root,
          XDG_STATE_HOME: stateRoot,
          AISY_OWNED_DOCKER_RECOVERY: '1',
          AISY_OWNED_DOCKER_SOCKET: '/run/docker.sock',
          AISY_OWNED_DOCKER_INSTALLATION_ID: 'b'.repeat(64),
          AISY_OWNED_DOCKER_SERVER_ID: 'daemon-one',
          AISY_OWNED_DOCKER_SERVER_VERSION: '29.5.2',
        },
      })

      expect(result.status).not.toBe(0)
      expect(existsSync(stateRoot)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

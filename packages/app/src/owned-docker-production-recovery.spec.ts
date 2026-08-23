import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  makeDockerRecoveryActivationTestFixture,
  type DockerRecoveryActivationTestFixture,
} from './__test_support__/docker-recovery-activation.js'
import { isNodeOwnedDockerParentRecoveryManager } from './owned-docker-parent-recovery-manager.js'
import {
  OWNED_DOCKER_LEDGER_FILENAME,
} from './execution-owned-docker-resources.js'
import {
  enrollNodeOwnedDockerProductionRecovery,
  makeNodeOwnedDockerProductionRecovery,
  makeNodeOwnedDockerProductionRecoveryDoctorProbe,
  ownedDockerProductionRecoveryRequested,
  OwnedDockerProductionRecoveryError,
} from './owned-docker-production-recovery.js'

const INSTALLATION_ID = 'a'.repeat(64)
const roots: string[] = []
const fixtures: DockerRecoveryActivationTestFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stateRoot(): string {
  const value = mkdtempSync(join(tmpdir(), 'aisy-production-docker-'))
  roots.push(value)
  return join(value, 'state')
}

async function fixture(): Promise<DockerRecoveryActivationTestFixture> {
  const value = await makeDockerRecoveryActivationTestFixture()
  fixtures.push(value)
  return value
}

function env(f: DockerRecoveryActivationTestFixture): Record<string, string> {
  return {
    AISY_OWNED_DOCKER_RECOVERY: '1',
    AISY_OWNED_DOCKER_SOCKET: f.socketPath,
    AISY_OWNED_DOCKER_INSTALLATION_ID: INSTALLATION_ID,
    AISY_OWNED_DOCKER_SERVER_ID: f.endpointIdentity.serverId,
    AISY_OWNED_DOCKER_SERVER_VERSION: f.endpointIdentity.serverVersion,
  }
}

describe('production parent-owned Docker recovery composition', () => {
  it('is I/O-free while disabled', () => {
    const root = stateRoot()
    expect(ownedDockerProductionRecoveryRequested({})).toBe(false)
    expect(makeNodeOwnedDockerProductionRecovery({ source: {}, stateRoot: root })).toBeNull()
    expect(existsSync(root)).toBe(false)
  })

  it('rejects partial, malformed and proxy configuration without touching state', () => {
    const root = stateRoot()
    for (const source of [
      { AISY_OWNED_DOCKER_RECOVERY: '1' },
      { AISY_OWNED_DOCKER_RECOVERY: '0', AISY_OWNED_DOCKER_SOCKET: '/tmp/docker.sock' },
      { AISY_OWNED_DOCKER_RECOVERY: 'yes' },
      {
        AISY_OWNED_DOCKER_RECOVERY: '1',
        AISY_OWNED_DOCKER_SOCKET: 'relative.sock',
        AISY_OWNED_DOCKER_INSTALLATION_ID: INSTALLATION_ID,
        AISY_OWNED_DOCKER_SERVER_ID: 'daemon-one',
        AISY_OWNED_DOCKER_SERVER_VERSION: '29.5.2',
      },
      new Proxy({}, {}),
    ]) {
      expect(() => ownedDockerProductionRecoveryRequested(source)).toThrowError(
        OwnedDockerProductionRecoveryError,
      )
    }
    expect(existsSync(root)).toBe(false)
  })

  it('snapshots top-level input without invoking accessors', () => {
    let reads = 0
    const hostile = { source: {} } as { source: unknown; stateRoot?: string }
    Object.defineProperty(hostile, 'stateRoot', {
      enumerable: true,
      get() { reads += 1; return stateRoot() },
    })
    expect(() => makeNodeOwnedDockerProductionRecovery(hostile as never)).toThrowError(
      OwnedDockerProductionRecoveryError,
    )
    expect(reads).toBe(0)
  })

  it('requires explicit enrollment, then recovers before child readiness and reopens safely', async () => {
    const f = await fixture()
    const root = stateRoot()
    expect(() => makeNodeOwnedDockerProductionRecovery({ source: env(f), stateRoot: root }))
      .toThrowError()
    expect(existsSync(root)).toBe(false)
    enrollNodeOwnedDockerProductionRecovery({ source: env(f), stateRoot: root })
    const first = makeNodeOwnedDockerProductionRecovery({ source: env(f), stateRoot: root })
    expect(isNodeOwnedDockerParentRecoveryManager(first)).toBe(true)
    await expect(first?.recoverBeforeFirstChild()).resolves.toEqual({ kind: 'ready' })
    expect(first?.isReady()).toBe(true)
    await first?.close()

    const second = makeNodeOwnedDockerProductionRecovery({ source: env(f), stateRoot: root })
    await expect(second?.recoverBeforeFirstChild()).resolves.toEqual({ kind: 'ready' })
    await second?.close()
  })

  it('fails closed when the configured daemon identity is not the pinned daemon', async () => {
    const f = await fixture()
    const root = stateRoot()
    enrollNodeOwnedDockerProductionRecovery({ source: env(f), stateRoot: root })
    const configured = env(f)
    configured.AISY_OWNED_DOCKER_SERVER_ID = 'different-engine'
    expect(() => makeNodeOwnedDockerProductionRecovery({ source: configured, stateRoot: root }))
      .toThrowError()
  })

  it('projects disabled, missing and ready doctor state without ledger mutation', async () => {
    const f = await fixture()
    const root = stateRoot()
    const disabledInput: { source: unknown; stateRoot: string } = { source: {}, stateRoot: root }
    const disabledProbe = makeNodeOwnedDockerProductionRecoveryDoctorProbe(disabledInput)
    disabledInput.source = env(f)
    await expect(disabledProbe.inspect()).resolves.toEqual({ state: 'disabled' })
    expect(existsSync(root)).toBe(false)

    await expect(makeNodeOwnedDockerProductionRecoveryDoctorProbe({
      source: { AISY_OWNED_DOCKER_RECOVERY: '1' }, stateRoot: root,
    }).inspect()).resolves.toEqual({ state: 'invalid-config' })
    expect(existsSync(root)).toBe(false)

    await expect(makeNodeOwnedDockerProductionRecoveryDoctorProbe({
      source: env(f), stateRoot: root,
    }).inspect()).resolves.toEqual({ state: 'ledger-unavailable' })
    expect(existsSync(root)).toBe(false)

    enrollNodeOwnedDockerProductionRecovery({ source: env(f), stateRoot: root })
    const ledgerPath = join(root, 'owned-docker-v4', OWNED_DOCKER_LEDGER_FILENAME)
    const before = readFileSync(ledgerPath)
    await expect(makeNodeOwnedDockerProductionRecoveryDoctorProbe({
      source: env(f), stateRoot: root,
    }).inspect()).resolves.toEqual({ state: 'ready' })
    expect(readFileSync(ledgerPath)).toEqual(before)
    expect(existsSync(ledgerPath + '-wal')).toBe(false)
    expect(existsSync(ledgerPath + '-shm')).toBe(false)
  })
})

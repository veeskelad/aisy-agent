import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  makeDockerRecoveryActivationTestFixture,
  type DockerRecoveryActivationTestFixture,
} from './__test_support__/docker-recovery-activation.js'
import {
  consumeOwnedDockerAttemptedCreatePermitV1,
  initializeOwnedDockerResourceLedger,
  mintOwnedDockerAttestedCreateOutcomeV1,
  openActivatedOwnedDockerResourceLedger,
  type OwnedDockerActiveEpoch,
  type OwnedDockerAttestedCommandPort,
  type OwnedDockerLedgerActivationV4,
  type OwnedDockerObservedResourceV2,
  type OwnedDockerRecoveryLedger,
} from './execution-owned-docker-resources.js'
import {
  isNodeOwnedDockerParentRecoveryManager,
  makeNodeOwnedDockerParentRecoveryManager,
  OwnedDockerParentRecoveryManagerError,
} from './owned-docker-parent-recovery-manager.js'

const INSTALLATION_ID = '1'.repeat(64)
const POLICY_HASH = '2'.repeat(64)
const CREATE_HASH = '3'.repeat(64)
const BOUND_HASH = '4'.repeat(64)
const OBJECT_ID = '5'.repeat(64)
const roots: string[] = []
const fixtures: DockerRecoveryActivationTestFixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const value = join(mkdtempSync(join(tmpdir(), 'aisy-parent-docker-')), 'ledger')
  roots.push(join(value, '..'))
  return value
}

async function fixture(): Promise<DockerRecoveryActivationTestFixture> {
  const value = await makeDockerRecoveryActivationTestFixture()
  fixtures.push(value)
  return value
}

function endpointPort(f: DockerRecoveryActivationTestFixture): OwnedDockerAttestedCommandPort {
  const ambiguous = async () => ({ kind: 'ambiguous' as const })
  return Object.freeze({
    endpointIdentity: f.endpointIdentity,
    probe: async () => ({ kind: 'ambiguous' as const }),
    scanInstallation: ambiguous,
    inspectById: ambiguous,
    inspectByName: ambiguous,
    removeById: ambiguous,
  })
}

function initialize(ledgerRoot: string, f: DockerRecoveryActivationTestFixture): OwnedDockerLedgerActivationV4 {
  return initializeOwnedDockerResourceLedger({
    root: ledgerRoot,
    installationId: INSTALLATION_ID,
    endpointIdentity: f.endpointIdentity,
  })
}

async function active(
  ledgerRoot: string,
  activation: OwnedDockerLedgerActivationV4,
  f: DockerRecoveryActivationTestFixture,
): Promise<{ ledger: OwnedDockerRecoveryLedger; epoch: OwnedDockerActiveEpoch }> {
  const ledger = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
  const recovered = await f.activate(ledger, endpointPort(f))
  return { ledger, epoch: recovered.activeEpoch }
}

function workerInput() {
  return {
    version: 2 as const,
    sidecarKind: 'whisper' as const,
    policyHash: POLICY_HASH,
    resources: [{
      version: 2 as const,
      role: 'worker' as const,
      resourceKind: 'container' as const,
      createProjectionContract: 'container-selected-v2' as const,
      createProjectionHash: CREATE_HASH,
    }],
  }
}

function manager(
  ledgerRoot: string,
  activation: OwnedDockerLedgerActivationV4,
  f: DockerRecoveryActivationTestFixture,
) {
  return makeNodeOwnedDockerParentRecoveryManager({
    root: ledgerRoot,
    activation,
    engine: {
      socketPath: f.socketPath,
      endpointIdentity: f.endpointIdentity,
      timeoutMs: 1_000,
    },
  })
}

describe('parent-owned Docker startup recovery manager', () => {
  it('activates an empty ledger, holds it until close and exposes no authority', async () => {
    const f = await fixture()
    const ledgerRoot = root()
    const activation = initialize(ledgerRoot, f)
    const recovery = manager(ledgerRoot, activation, f)

    expect(isNodeOwnedDockerParentRecoveryManager(recovery)).toBe(true)
    await expect(recovery.recoverBeforeFirstChild()).resolves.toEqual({ kind: 'ready' })
    expect(recovery.isReady()).toBe(true)
    expect(Object.keys(recovery).sort()).toEqual([
      'close', 'isReady', 'recoverBeforeFirstChild',
    ])
    expect(() => openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation }))
      .toThrowError()

    await recovery.close()
    expect(recovery.isReady()).toBe(false)
    const reopened = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
    reopened.close()
  })

  it('clears a fully prepared operation without Docker mutation before zero activation', async () => {
    const f = await fixture()
    const ledgerRoot = root()
    const activation = initialize(ledgerRoot, f)
    const prepared = await active(ledgerRoot, activation, f)
    prepared.epoch.prepare(workerInput())
    prepared.ledger.close()

    const recovery = manager(ledgerRoot, activation, f)
    await expect(recovery.recoverBeforeFirstChild()).resolves.toEqual({ kind: 'ready' })
    await recovery.close()

    const reopened = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
    expect(reopened.listOperations()).toEqual([])
    reopened.close()
  })

  it('keeps attempted intent and refuses child readiness when create is not yet visible', async () => {
    const f = await fixture()
    const ledgerRoot = root()
    const activation = initialize(ledgerRoot, f)
    const attempted = await active(ledgerRoot, activation, f)
    const operation = attempted.epoch.prepare(workerInput())
    await expect(operation.create('worker', async (_descriptor, permit) => {
      consumeOwnedDockerAttemptedCreatePermitV1(permit)
      throw new Error('lost create response')
    })).rejects.toThrowError()
    attempted.ledger.close()

    const recovery = manager(ledgerRoot, activation, f)
    await expect(recovery.recoverBeforeFirstChild()).rejects.toMatchObject({
      code: 'OWNED_DOCKER_PARENT_MANAGER_NOT_YET_VISIBLE',
    })
    expect(recovery.isReady()).toBe(false)

    const reopened = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
    expect(reopened.listOperations()[0]?.resources[0]?.phase).toBe('attempted')
    reopened.close()
  })

  it('cleans a bound-but-absent container and activates without DELETE retry', async () => {
    const f = await fixture()
    const ledgerRoot = root()
    const activation = initialize(ledgerRoot, f)
    const bound = await active(ledgerRoot, activation, f)
    const operation = bound.epoch.prepare(workerInput())
    await operation.create('worker', async (_descriptor, permit) => {
      const descriptor = consumeOwnedDockerAttemptedCreatePermitV1(permit)
      const observed: OwnedDockerObservedResourceV2 = Object.freeze({
        version: 2,
        objectId: OBJECT_ID,
        resourceKind: descriptor.resourceKind,
        name: descriptor.name,
        labels: descriptor.labels,
        createProjectionContract: descriptor.createProjectionContract,
        createProjectionHash: descriptor.createProjectionHash,
        projectionHashV1: BOUND_HASH,
        networkEndpointCount: null,
      })
      return mintOwnedDockerAttestedCreateOutcomeV1(observed)
    })
    bound.ledger.close()

    const recovery = manager(ledgerRoot, activation, f)
    await expect(recovery.recoverBeforeFirstChild()).resolves.toEqual({ kind: 'ready' })
    await recovery.close()
    const reopened = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
    expect(reopened.listOperations()).toEqual([])
    reopened.close()
  })

  it('refuses multiple operations without clearing their durable intent', async () => {
    const f = await fixture()
    const ledgerRoot = root()
    const activation = initialize(ledgerRoot, f)
    const prepared = await active(ledgerRoot, activation, f)
    prepared.epoch.prepare(workerInput())
    prepared.epoch.prepare(workerInput())
    prepared.ledger.close()

    const recovery = manager(ledgerRoot, activation, f)
    await expect(recovery.recoverBeforeFirstChild()).rejects.toMatchObject({
      code: 'OWNED_DOCKER_PARENT_MANAGER_GRAPH_UNSUPPORTED',
    })
    const reopened = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
    expect(reopened.listOperations()).toHaveLength(2)
    expect(reopened.listOperations().every(operation =>
      operation.resources.length === 1 && operation.resources[0]?.phase === 'prepared')).toBe(true)
    reopened.close()
  })

  it('pre-abort performs no recovery transition or child-ready publication', async () => {
    const f = await fixture()
    const ledgerRoot = root()
    const activation = initialize(ledgerRoot, f)
    const recovery = manager(ledgerRoot, activation, f)
    const controller = new AbortController()
    controller.abort()

    await expect(recovery.recoverBeforeFirstChild({ signal: controller.signal }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_PARENT_MANAGER_RECOVERY_FAILED' })
    expect(recovery.isReady()).toBe(false)
    const reopened = openActivatedOwnedDockerResourceLedger({ root: ledgerRoot, activation })
    expect(reopened.listOperations()).toEqual([])
    reopened.close()
  })

  it('snapshots mutable options and rejects structural copies, Proxy and replay', async () => {
    const f = await fixture()
    const ledgerRoot = root()
    const activation = initialize(ledgerRoot, f)
    const engine = {
      socketPath: f.socketPath,
      endpointIdentity: f.endpointIdentity,
      timeoutMs: 1_000,
    }
    const recovery = makeNodeOwnedDockerParentRecoveryManager({ root: ledgerRoot, activation, engine })
    engine.socketPath = '/tmp/replaced.sock'
    await expect(recovery.recoverBeforeFirstChild()).resolves.toEqual({ kind: 'ready' })
    await expect(recovery.recoverBeforeFirstChild()).rejects.toBeInstanceOf(
      OwnedDockerParentRecoveryManagerError,
    )
    expect(isNodeOwnedDockerParentRecoveryManager({ ...recovery })).toBe(false)
    expect(() => makeNodeOwnedDockerParentRecoveryManager(new Proxy({
      root: ledgerRoot,
      activation,
      engine,
    }, {}) as never)).toThrowError()
    await recovery.close()
  })

  it('is constructed in production only through the opt-in narrowing adapter', () => {
    const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')
    expect(production).toContain('owned-docker-production-recovery')
    expect(production).toContain('makeNodeOwnedDockerProductionRecovery')
    expect(production).not.toContain('owned-docker-parent-recovery-manager')
    expect(production).not.toContain('makeNodeOwnedDockerParentRecoveryManager')
  })
})

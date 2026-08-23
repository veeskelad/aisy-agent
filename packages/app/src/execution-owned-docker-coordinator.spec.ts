import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  makeDockerRecoveryActivationTestFixture,
  type DockerRecoveryActivationTestFixture,
} from './__test_support__/docker-recovery-activation.js'

import {
  captureOwnedDockerRecoveryAuthorityEpoch,
  consumeOwnedDockerAttemptedContainerRecoveryPermitV1,
  consumeOwnedDockerAttemptedCreatePermitV1,
  consumeOwnedDockerBoundContainerUsePermitV1,
  initializeOwnedDockerResourceLedger,
  isOwnedDockerActiveEpoch,
  isOwnedDockerOperationHandle,
  mintOwnedDockerAttestedAttemptedContainerRecoveryFoundOutcomeV1,
  mintOwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1,
  mintOwnedDockerAttestedCreateOutcomeV1,
  openActivatedOwnedDockerResourceLedger,
  ownedDockerActiveEpochMatchesEndpointIdentity,
  OWNED_DOCKER_LEDGER_FILENAME,
  reconcileOwnedDockerResources,
  type OwnedDockerCommandPort,
  type OwnedDockerCreateDescriptorV2,
  type OwnedDockerEndpointIdentityV1,
  type OwnedDockerInspectResult,
  type OwnedDockerObservedResourceV2,
  type OwnedDockerRemoveResult,
  type OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1,
  type OwnedDockerResourceKind,
} from './execution-owned-docker-resources.js'

const INSTALLATION_ID = '1'.repeat(64)
let activationFixture: DockerRecoveryActivationTestFixture
let ENDPOINT_IDENTITY: OwnedDockerEndpointIdentityV1
const POLICY_HASH = '4'.repeat(64)
const PROJECTION = {
  worker: 'a'.repeat(64), gateway: 'b'.repeat(64), network: 'c'.repeat(64),
} as const
const BOUND_PROJECTION_V1 = {
  worker: 'd'.repeat(64), gateway: 'e'.repeat(64), network: PROJECTION.network,
} as const
const roots: string[] = []

beforeAll(async () => {
  activationFixture = await makeDockerRecoveryActivationTestFixture()
  ENDPOINT_IDENTITY = activationFixture.endpointIdentity
})
afterAll(async () => activationFixture.close())

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function ledgerRoot(): string {
  const base = mkdtempSync(join(tmpdir(), 'aisy-owned-docker-coordinator-'))
  roots.push(base)
  return join(base, 'ledger')
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class FakeDocker implements OwnedDockerCommandPort {
  endpointIdentity: OwnedDockerEndpointIdentityV1 = ENDPOINT_IDENTITY
  readonly calls: string[] = []
  readonly resources = new Map<string, OwnedDockerObservedResourceV2>()
  inspectOverride: ((kind: OwnedDockerResourceKind, id: string) => OwnedDockerInspectResult) | null = null
  removeOverride: ((kind: OwnedDockerResourceKind, id: string) => OwnedDockerRemoveResult) | null = null
  probeKind: 'compatible' | 'incompatible' | 'ambiguous' = 'compatible'
  probeBarrier: Promise<void> | null = null
  probeEntered: (() => void) | null = null
  probeThrows = false
  scanBarrier: Promise<void> | null = null
  scanEntered: (() => void) | null = null
  inspectBarrier: Promise<void> | null = null
  inspectEntered: (() => void) | null = null
  removeBarrier: Promise<void> | null = null
  removeEntered: (() => void) | null = null

  add(
    descriptor: OwnedDockerCreateDescriptorV2,
    objectId: string,
    endpoints: number | null = null,
    projectionHashV1 = BOUND_PROJECTION_V1[descriptor.role],
  ): void {
    this.resources.set(objectId, Object.freeze({
      version: 2 as const,
      objectId,
      resourceKind: descriptor.resourceKind,
      name: descriptor.name,
      labels: descriptor.labels,
      createProjectionContract: descriptor.createProjectionContract,
      createProjectionHash: descriptor.createProjectionHash,
      projectionHashV1,
      networkEndpointCount: descriptor.resourceKind === 'network' ? (endpoints ?? 0) : null,
    }))
  }
  async probe() {
    this.calls.push('probe')
    this.probeEntered?.()
    if (this.probeBarrier !== null) await this.probeBarrier
    if (this.probeThrows) throw new Error('probe failed')
    return { kind: this.probeKind } as const
  }
  async scanInstallation(installationId: string) {
    this.calls.push('scan')
    this.scanEntered?.()
    if (this.scanBarrier !== null) await this.scanBarrier
    return { kind: 'ok', resources: [...this.resources.values()].filter(item =>
      item.labels.installationId === installationId) } as const
  }
  async inspectById(input: { resourceKind: OwnedDockerResourceKind; objectId: string }) {
    this.calls.push(`inspect:${input.objectId[0]}`)
    this.inspectEntered?.()
    if (this.inspectBarrier !== null) await this.inspectBarrier
    if (this.inspectOverride !== null) return this.inspectOverride(input.resourceKind, input.objectId)
    const resource = this.resources.get(input.objectId)
    return resource === undefined ? { kind: 'absent' } as const : { kind: 'found', resource } as const
  }
  async inspectByName(input: { resourceKind: OwnedDockerResourceKind; name: string }) {
    this.calls.push(`name:${input.name}`)
    const resource = [...this.resources.values()].find(item =>
      item.resourceKind === input.resourceKind && item.name === input.name)
    return resource === undefined ? { kind: 'absent' } as const : { kind: 'found', resource } as const
  }
  async removeById(input: { resourceKind: OwnedDockerResourceKind; objectId: string }) {
    this.calls.push(`remove:${input.objectId[0]}`)
    this.removeEntered?.()
    if (this.removeBarrier !== null) await this.removeBarrier
    if (this.removeOverride !== null) return this.removeOverride(input.resourceKind, input.objectId)
    const existed = this.resources.delete(input.objectId)
    return existed ? { kind: 'removed' } as const : { kind: 'absent' } as const
  }
}

function workerInput() {
  return {
    version: 2 as const,
    sidecarKind: 'whisper' as const,
    policyHash: POLICY_HASH,
    resources: [{ version: 2 as const, role: 'worker' as const,
      resourceKind: 'container' as const,
      createProjectionContract: 'container-selected-v2' as const,
      createProjectionHash: PROJECTION.worker }],
  }
}
function cloneInput() {
  return {
    version: 2 as const,
    sidecarKind: 'restricted-clone' as const,
    policyHash: POLICY_HASH,
    resources: [
      { version: 2 as const, role: 'worker' as const,
        resourceKind: 'container' as const, createProjectionContract: 'container-selected-v2' as const,
        createProjectionHash: PROJECTION.worker },
      { version: 2 as const, role: 'gateway' as const,
        resourceKind: 'container' as const, createProjectionContract: 'container-selected-v2' as const,
        createProjectionHash: PROJECTION.gateway },
      { version: 2 as const, role: 'network' as const,
        resourceKind: 'network' as const, createProjectionContract: 'network-full-v1' as const,
        createProjectionHash: PROJECTION.network },
    ],
  }
}
async function harness() {
  const root = ledgerRoot()
  const activation = initializeOwnedDockerResourceLedger({
    root, installationId: INSTALLATION_ID, endpointIdentity: ENDPOINT_IDENTITY,
  })
  const ledger = openActivatedOwnedDockerResourceLedger({ root, activation })
  const docker = new FakeDocker()
  await reconcileOwnedDockerResources({ ledger, docker })
  const recovered = await activationFixture.activate(ledger, docker)
  return { root, activation, ledger, docker, active: recovered.activeEpoch }
}

async function reconcileAndActivate(
  ledger: ReturnType<typeof openActivatedOwnedDockerResourceLedger>,
  docker: FakeDocker,
) {
  const reconciled = await reconcileOwnedDockerResources({ ledger, docker })
  const activated = await activationFixture.activate(ledger, docker)
  return Object.freeze({
    ...activated,
    clearedOperations: reconciled.clearedOperations,
    removedResources: reconciled.removedResources,
  })
}

async function attemptedRecoveryHarness() {
  const value = await harness()
  const operation = value.active.prepare(workerInput())
  await expect(operation.create('worker', async () => {
    throw new Error('create response lost')
  })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
  await expect(reconcileOwnedDockerResources({ ledger: value.ledger, docker: value.docker }))
    .rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
  value.docker.calls.splice(0)
  return {
    ...value,
    operation,
    recoveryEpoch: captureOwnedDockerRecoveryAuthorityEpoch(value.ledger),
  }
}

describe('owned Docker active epoch coordinator', () => {
  it('brands active epochs and operation handles without trusting structural lookalikes', async () => {
    const { ledger, active } = await harness()
    const operation = active.prepare(workerInput())

    expect(isOwnedDockerActiveEpoch(active)).toBe(true)
    expect(isOwnedDockerOperationHandle(operation)).toBe(true)
    expect(isOwnedDockerActiveEpoch({ ...active })).toBe(false)
    expect(isOwnedDockerOperationHandle({ ...operation })).toBe(false)
    expect(isOwnedDockerActiveEpoch(new Proxy(active, {}))).toBe(false)
    expect(isOwnedDockerOperationHandle(new Proxy(operation, {}))).toBe(false)
    expect(isOwnedDockerActiveEpoch({ epoch: active.epoch, prepare: active.prepare })).toBe(false)
    expect(isOwnedDockerOperationHandle({
      operationBindingHash: operation.operationBindingHash,
      resources: operation.resources,
      create: operation.create,
      complete: operation.complete,
    })).toBe(false)

    ledger.close()
  })

  it('matches a genuine active epoch to its hidden exact endpoint without invoking getters', async () => {
    const { ledger, active } = await harness()
    expect(ownedDockerActiveEpochMatchesEndpointIdentity(active, ENDPOINT_IDENTITY)).toBe(true)
    expect(ownedDockerActiveEpochMatchesEndpointIdentity(
      active,
      { ...ENDPOINT_IDENTITY, serverId: 'replacement-engine' },
    )).toBe(false)
    expect(ownedDockerActiveEpochMatchesEndpointIdentity({ ...active }, ENDPOINT_IDENTITY)).toBe(false)
    expect(ownedDockerActiveEpochMatchesEndpointIdentity(
      active,
      new Proxy(ENDPOINT_IDENTITY, {}),
    )).toBe(false)

    let getterCalls = 0
    const hostile = { ...ENDPOINT_IDENTITY }
    Object.defineProperty(hostile, 'serverId', {
      enumerable: true,
      get() { getterCalls += 1; return ENDPOINT_IDENTITY.serverId },
    })
    expect(ownedDockerActiveEpochMatchesEndpointIdentity(active, hostile)).toBe(false)
    expect(getterCalls).toBe(0)

    ledger.close()
  })

  it('allocates identity, exact names, and labels only from monotonic ledger state', async () => {
    const { root, ledger, active } = await harness()
    const first = active.prepare(workerInput())
    const second = active.prepare(workerInput())
    expect(first.operationBindingHash).toMatch(/^[a-f0-9]{64}$/)
    expect(second.operationBindingHash).not.toBe(first.operationBindingHash)
    expect(first.resources[0]).toMatchObject({
      operationBindingHash: first.operationBindingHash,
      name: expect.stringMatching(/^aisy-whisper-worker-[a-f0-9]{24}$/),
      labels: {
        version: '1', installationId: INSTALLATION_ID,
        operationBindingHash: first.operationBindingHash,
        ownerBindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        sessionBindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect('bind' in first).toBe(false)
    expect('clear' in first).toBe(false)
    const db = new Database(join(root, OWNED_DOCKER_LEDGER_FILENAME), { readonly: true })
    expect(db.prepare('SELECT operation_seq FROM ledger_meta').pluck().get()).toBe(2)
    expect(db.prepare('SELECT operation_seq FROM operations ORDER BY operation_seq').pluck().all())
      .toEqual([1, 2])
    const serialized = JSON.stringify(db.prepare('SELECT * FROM operations').all())
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toContain('/tmp/')
    db.close()
    ledger.close()
  })

  it('durably marks attempted immediately before dispatch and exposes use only after bind', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    expect('use' in operation).toBe(false)
    const bound = await operation.create('worker', async descriptor => {
      expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
      docker.add(descriptor, 'd'.repeat(64))
    })
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      createProjectionContract: 'container-selected-v2',
      createProjectionHash: PROJECTION.worker,
      boundProjectionHashV1: BOUND_PROJECTION_V1.worker,
      phase: 'bound', objectId: 'd'.repeat(64),
    })
    await expect(bound.use(async value => ({
      objectId: value.objectId,
      create: value.createProjectionHash,
      bound: value.boundProjectionHashV1,
    }))).resolves.toEqual({
      objectId: 'd'.repeat(64),
      create: PROJECTION.worker,
      bound: BOUND_PROJECTION_V1.worker,
    })
    ledger.close()
  })

  it('issues a genuine one-shot bound-container use permit only after exact inspect', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const bound = await operation.create('worker', async descriptor => {
      docker.add(descriptor, 'd'.repeat(64))
    })
    let captured: unknown

    await expect(bound.useContainer(async (descriptor, permit) => {
      captured = permit
      for (const candidate of [
        { ...permit },
        new Proxy(permit, {}),
        {
          version: 1,
          operationBindingHash: permit.operationBindingHash,
          role: permit.role,
          objectId: permit.objectId,
        },
      ]) {
        expect(() => consumeOwnedDockerBoundContainerUsePermitV1(
          candidate, ledger.activation.endpointIdentity,
        ))
          .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
      }
      expect(consumeOwnedDockerBoundContainerUsePermitV1(
        permit, ledger.activation.endpointIdentity,
      )).toBe(descriptor)
      expect(() => consumeOwnedDockerBoundContainerUsePermitV1(
        permit, ledger.activation.endpointIdentity,
      ))
        .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
      return descriptor.objectId
    })).resolves.toBe('d'.repeat(64))

    expect(() => consumeOwnedDockerBoundContainerUsePermitV1(
      captured, ledger.activation.endpointIdentity,
    ))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: 'd'.repeat(64),
    })
    ledger.close()
  })

  it('burns a genuine bound-container use permit presented by another endpoint', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const bound = await operation.create('worker', async descriptor => {
      docker.add(descriptor, 'd'.repeat(64))
    })

    await expect(bound.useContainer(async (_descriptor, permit) => {
      const foreignEndpoint = Object.freeze({
        ...ledger.activation.endpointIdentity,
        serverId: 'foreign-engine',
      })
      expect(() => consumeOwnedDockerBoundContainerUsePermitV1(permit, foreignEndpoint))
        .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' }))
      expect(() => consumeOwnedDockerBoundContainerUsePermitV1(
        permit, ledger.activation.endpointIdentity,
      )).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
      return 'refused'
    })).resolves.toBe('refused')

    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: 'd'.repeat(64),
    })
    ledger.close()
  })

  it('revokes an unused bound-container use permit and represents no Docker mutation', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const bound = await operation.create('worker', async descriptor => {
      docker.add(descriptor, 'd'.repeat(64))
    })
    let captured: unknown
    docker.calls.splice(0)

    await expect(bound.useContainer(async (_descriptor, permit) => {
      captured = permit
      return 'not-dispatched'
    })).resolves.toBe('not-dispatched')
    expect(() => consumeOwnedDockerBoundContainerUsePermitV1(
      captured, ledger.activation.endpointIdentity,
    ))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
    expect(docker.calls).toEqual(['inspect:d'])
    ledger.close()
  })

  it('mints a create permit only after attempted and revokes an unused permit after dispatch', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    let captured: unknown
    expect(captured).toBeUndefined()
    docker.calls.splice(0)

    await expect(operation.create('worker', async (_descriptor, permit) => {
      expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
      captured = permit
      return { kind: 'create-ambiguous' as const }
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
    expect(() => consumeOwnedDockerAttemptedCreatePermitV1(captured))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
    expect(docker.calls).toEqual([])
    ledger.close()
  })

  it('accepts only the exact attempted permit once and never calls Docker while rejecting copies', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    docker.calls.splice(0)

    await expect(operation.create('worker', async (descriptor, permit) => {
      const forged = {
        version: 1,
        operationBindingHash: descriptor.operationBindingHash,
        role: descriptor.role,
      }
      for (const candidate of [forged, { ...permit }, new Proxy(permit, {})]) {
        expect(() => consumeOwnedDockerAttemptedCreatePermitV1(candidate))
          .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
      }
      expect(consumeOwnedDockerAttemptedCreatePermitV1(permit)).toBe(descriptor)
      expect(() => consumeOwnedDockerAttemptedCreatePermitV1(permit))
        .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
      return { kind: 'create-ambiguous' as const }
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
    expect(docker.calls).toEqual([])
    ledger.close()
  })

  it.each(['void', 'throw'] as const)(
    'does not discover Docker after a consumed permit and a %s dispatch result', async result => {
      const { ledger, docker, active } = await harness()
      const operation = active.prepare(workerInput())
      docker.calls.splice(0)

      await expect(operation.create('worker', async (descriptor, permit) => {
        expect(consumeOwnedDockerAttemptedCreatePermitV1(permit)).toBe(descriptor)
        if (result === 'throw') throw new Error('transport result lost')
      })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
      expect(docker.calls).toEqual([])
      expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
      ledger.close()
    },
  )

  it('burns the permit before an endpoint recheck fails and represents no create', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    let representedCreates = 0
    let consumeFailure: unknown
    docker.calls.splice(0)

    await expect(operation.create('worker', async (_descriptor, permit) => {
      docker.endpointIdentity = { ...ENDPOINT_IDENTITY, serverId: 'replacement-engine' }
      try {
        consumeOwnedDockerAttemptedCreatePermitV1(permit)
        representedCreates += 1
      } catch (error) {
        consumeFailure = error
      }
      expect(() => consumeOwnedDockerAttemptedCreatePermitV1(permit))
        .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
      return { kind: 'create-ambiguous' as const }
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(consumeFailure).toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(representedCreates).toBe(0)
    expect(docker.calls).toEqual([])
    docker.endpointIdentity = ENDPOINT_IDENTITY
    ledger.close()
  })

  it('binds an exact attested create outcome without scanning or inspecting Docker', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const objectId = 'd'.repeat(64)
    docker.calls.splice(0)

    const bound = await operation.create('worker', async (descriptor, permit) => {
      expect(consumeOwnedDockerAttemptedCreatePermitV1(permit)).toBe(descriptor)
      docker.add(descriptor, objectId)
      return mintOwnedDockerAttestedCreateOutcomeV1(docker.resources.get(objectId)!)
    })

    expect(bound.objectId).toBe(objectId)
    expect(docker.calls).toEqual([])
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId, boundProjectionHashV1: BOUND_PROJECTION_V1.worker,
    })
    ledger.close()
  })

  it('keeps an explicit ambiguous create attempted without discovery or redispatch', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    let dispatches = 0
    docker.calls.splice(0)

    await expect(operation.create('worker', async () => {
      dispatches += 1
      return { kind: 'create-ambiguous' as const }
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'attempted', objectId: null, boundProjectionHashV1: null,
    })
    expect(docker.calls).toEqual([])

    await expect(operation.create('worker', async () => {
      dispatches += 1
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
    expect(dispatches).toBe(1)
    expect(docker.calls).toEqual([])
    ledger.close()
  })

  it('rejects mismatched attested create evidence without binding or discovery', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const objectId = 'd'.repeat(64)
    docker.calls.splice(0)

    await expect(operation.create('worker', async (descriptor, permit) => {
      expect(consumeOwnedDockerAttemptedCreatePermitV1(permit)).toBe(descriptor)
      docker.add(descriptor, objectId)
      return mintOwnedDockerAttestedCreateOutcomeV1(Object.freeze({
        ...docker.resources.get(objectId)!,
        createProjectionHash: '9'.repeat(64),
      }))
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_OWNERSHIP_UNPROVEN' })
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'attempted', objectId: null, boundProjectionHashV1: null,
    })
    expect(docker.calls).toEqual([])
    ledger.close()
  })

  it.each(['manual', 'spread', 'proxy'] as const)(
    'rejects %s matching create evidence without binding or discovery', async variant => {
      const { ledger, docker, active } = await harness()
      const operation = active.prepare(workerInput())
      const objectId = 'd'.repeat(64)
      docker.add(operation.resources[0]!, objectId)
      const observed = docker.resources.get(objectId)!
      const genuine = mintOwnedDockerAttestedCreateOutcomeV1(observed)
      const forged = variant === 'manual'
        ? { kind: 'attested-created' as const, observed }
        : variant === 'spread' ? { ...genuine } : new Proxy(genuine, {})
      docker.calls.splice(0)

      await expect(operation.create('worker', async () => forged))
        .rejects.toMatchObject({ code: 'OWNED_DOCKER_INPUT_INVALID' })
      expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
        phase: 'attempted', objectId: null, boundProjectionHashV1: null,
      })
      let redispatches = 0
      await expect(operation.create('worker', async () => {
        redispatches += 1
      })).rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
      expect(redispatches).toBe(0)
      expect(docker.calls).toEqual([])
      ledger.close()
    },
  )

  it('rejects hostile attested create envelopes without invoking accessors or discovery', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    let getterCalls = 0
    const hostile = { kind: 'attested-created' }
    Object.defineProperty(hostile, 'observed', {
      enumerable: true,
      get() { getterCalls += 1; return null },
    })
    docker.calls.splice(0)

    await expect(operation.create('worker', async () => hostile as never))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_INPUT_INVALID' })
    expect(getterCalls).toBe(0)
    expect(docker.calls).toEqual([])
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'attempted', objectId: null, boundProjectionHashV1: null,
    })
    ledger.close()
  })

  it('rechecks endpoint and epoch authority before accepting attested create evidence', async () => {
    const { ledger, docker, active } = await harness()
    const endpointOperation = active.prepare(workerInput())
    const objectId = 'd'.repeat(64)
    docker.calls.splice(0)

    await expect(endpointOperation.create('worker', async (descriptor, permit) => {
      expect(consumeOwnedDockerAttemptedCreatePermitV1(permit)).toBe(descriptor)
      docker.add(descriptor, objectId)
      docker.endpointIdentity = { ...ENDPOINT_IDENTITY, serverId: 'replacement-engine' }
      return mintOwnedDockerAttestedCreateOutcomeV1(docker.resources.get(objectId)!)
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'attempted', objectId: null, boundProjectionHashV1: null,
    })
    expect(docker.calls).toEqual([])

    docker.endpointIdentity = ENDPOINT_IDENTITY
    const staleOperation = active.prepare(workerInput())
    await reconcileOwnedDockerResources({ ledger, docker })
    docker.calls.splice(0)
    let dispatches = 0
    await expect(staleOperation.create('worker', async () => {
      dispatches += 1
      return { kind: 'create-ambiguous' as const }
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_EPOCH_STALE' })
    expect(dispatches).toBe(0)
    expect(docker.calls).toEqual([])
    ledger.close()
  })

  it('compares selected-v2 before bind and leaves the durable pair null on mismatch', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    await expect(operation.create('worker', async descriptor => {
      const objectId = 'd'.repeat(64)
      docker.add(descriptor, objectId)
      docker.resources.set(objectId, Object.freeze({
        ...docker.resources.get(objectId)!,
        createProjectionHash: '9'.repeat(64),
      }))
    })).rejects.toMatchObject({ code: 'OWNED_DOCKER_OWNERSHIP_UNPROVEN' })
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'attempted', objectId: null, boundProjectionHashV1: null,
      createProjectionHash: PROJECTION.worker,
    })
    ledger.close()
  })

  it.each([
    ['selected-v2', { createProjectionHash: '8'.repeat(64) }],
    ['durable full-v1', { projectionHashV1: '8'.repeat(64) }],
  ] as const)('rejects bound container drift in %s evidence', async (_name, drift) => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const objectId = 'd'.repeat(64)
    const bound = await operation.create('worker', async descriptor => docker.add(descriptor, objectId))
    docker.resources.set(objectId, Object.freeze({ ...docker.resources.get(objectId)!, ...drift }))
    await expect(bound.use(async () => 'unsafe'))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_OWNERSHIP_UNPROVEN' })
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId, createProjectionHash: PROJECTION.worker,
      boundProjectionHashV1: BOUND_PROJECTION_V1.worker,
    })
    ledger.close()
  })

  it('SQL phase checks reject every partial object/full-v1 bind state', async () => {
    const { root, ledger, active } = await harness()
    active.prepare(workerInput())
    const db = new Database(join(root, OWNED_DOCKER_LEDGER_FILENAME), { fileMustExist: true })
    expect(() => db.prepare('UPDATE resources SET object_id = ?').run('d'.repeat(64)))
      .toThrowError(/CHECK constraint failed/)
    expect(() => db.prepare('UPDATE resources SET bound_projection_hash_v1 = ?').run('e'.repeat(64)))
      .toThrowError(/CHECK constraint failed/)
    expect(() => db.prepare("UPDATE resources SET phase = 'bound'").run())
      .toThrowError(/CHECK constraint failed/)
    expect(db.prepare(
      'SELECT phase, object_id, bound_projection_hash_v1, object_integrity_hash FROM resources',
    ).get()).toEqual({
      phase: 'prepared', object_id: null, bound_projection_hash_v1: null,
      object_integrity_hash: null,
    })
    db.close()
    ledger.close()
  })

  it('rejects active resource corruption before Docker I/O or manager rotation', async () => {
    const { root, ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const db = new Database(path, { fileMustExist: true })
    const managerBefore = db.prepare('SELECT manager_state, manager_epoch, operation_seq FROM ledger_meta').get()
    db.prepare('UPDATE resources SET create_projection_hash = ?').run('8'.repeat(64))
    const resourceBefore = db.prepare('SELECT * FROM resources').get()
    db.close()
    docker.calls.splice(0)
    await expect(operation.complete()).rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_CORRUPT' })
    expect(docker.calls).toEqual([])
    const after = new Database(path, { readonly: true, fileMustExist: true })
    expect(after.prepare('SELECT manager_state, manager_epoch, operation_seq FROM ledger_meta').get())
      .toEqual(managerBefore)
    expect(after.prepare('SELECT * FROM resources').get()).toEqual(resourceBefore)
    after.close()
    ledger.close()
  })

  it('does not let inherited toJSON collapse operation or integrity domains', async () => {
    const { ledger, active } = await harness()
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    Object.defineProperty(Object.prototype, 'toJSON', {
      value(this: Record<string, unknown>) {
        if (this['version'] === 1 && typeof this['role'] === 'string' &&
          typeof this['databaseId'] === 'string' && typeof this['dev'] === 'string' &&
          typeof this['ino'] === 'string') return this
        return 'polluted'
      },
      configurable: true,
    })
    try {
      const first = active.prepare(workerInput())
      const second = active.prepare(workerInput())
      expect(first.operationBindingHash).toMatch(/^[a-f0-9]{64}$/)
      expect(second.operationBindingHash).toMatch(/^[a-f0-9]{64}$/)
      expect(second.operationBindingHash).not.toBe(first.operationBindingHash)
      expect(ledger.listOperations()).toHaveLength(2)
    } finally {
      if (previous === undefined) Reflect.deleteProperty(Object.prototype, 'toJSON')
      else Object.defineProperty(Object.prototype, 'toJSON', previous)
      ledger.close()
    }
  })

  it('recovers the create-return crash window by trusted discovery', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const bound = await operation.create('worker', async descriptor => {
      docker.add(descriptor, 'e'.repeat(64))
      throw new Error('transport died after Docker accepted create')
    })
    expect(bound.objectId).toBe('e'.repeat(64))
    expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('bound')
    ledger.close()
  })

  it('persists endpoint identity across restart and rejects a wrong daemon before cleanup', async () => {
    const { root, activation, ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    await operation.create('worker', async descriptor => docker.add(descriptor, 'e'.repeat(64)))
    ledger.close()

    const recoveryLedger = openActivatedOwnedDockerResourceLedger({ root, activation })
    docker.calls.splice(0)
    docker.endpointIdentity = { ...ENDPOINT_IDENTITY, serverId: 'replacement-engine' }
    await expect(reconcileOwnedDockerResources({ ledger: recoveryLedger, docker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(docker.calls).toEqual([])
    expect(docker.resources.has('e'.repeat(64))).toBe(true)
    expect(recoveryLedger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: 'e'.repeat(64),
    })

    docker.endpointIdentity = ENDPOINT_IDENTITY
    await expect(reconcileOwnedDockerResources({ ledger: recoveryLedger, docker }))
      .resolves.toMatchObject({ clearedOperations: 1, removedResources: 1 })
    recoveryLedger.close()
  })

  it('opens an active ledger without rotating epoch when the next daemon attestation is wrong', async () => {
    const { root, activation, ledger, docker, active } = await harness()
    ledger.close()
    const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
    const databaseEvidence = readFileSync(path)
    const statEvidence = lstatSync(path)
    const recoveryLedger = openActivatedOwnedDockerResourceLedger({ root, activation })
    docker.endpointIdentity = { ...ENDPOINT_IDENTITY, endpointBindingHash: '8'.repeat(64) }
    docker.calls.splice(0)
    await expect(reconcileOwnedDockerResources({ ledger: recoveryLedger, docker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(docker.calls).toEqual([])
    expect(readFileSync(path)).toEqual(databaseEvidence)
    const after = lstatSync(path)
    expect({ ino: after.ino, size: after.size, mtimeMs: after.mtimeMs })
      .toEqual({ ino: statEvidence.ino, size: statEvidence.size, mtimeMs: statEvidence.mtimeMs })
    const db = new Database(path, { readonly: true })
    expect(db.prepare('SELECT manager_state, manager_epoch FROM ledger_meta').get())
      .toEqual({ manager_state: 'active', manager_epoch: active.epoch })
    db.close()
    recoveryLedger.close()
  })

  it.each(['probe', 'scan'] as const)(
    'detects endpoint replacement after awaited %s and preserves recovery ledger state',
    async boundary => {
      const root = ledgerRoot()
      const activation = initializeOwnedDockerResourceLedger({
        root, installationId: INSTALLATION_ID, endpointIdentity: ENDPOINT_IDENTITY,
      })
      const ledger = openActivatedOwnedDockerResourceLedger({ root, activation })
      const docker = new FakeDocker()
      const entered = deferred()
      const release = deferred()
      if (boundary === 'probe') {
        docker.probeEntered = () => entered.resolve()
        docker.probeBarrier = release.promise
        docker.probeThrows = true
      } else {
        docker.scanEntered = () => entered.resolve()
        docker.scanBarrier = release.promise
      }
      const recovering = reconcileOwnedDockerResources({ ledger, docker })
      await entered.promise
      docker.endpointIdentity = { ...ENDPOINT_IDENTITY, apiVersion: '1.52' }
      release.resolve()
      await expect(recovering).rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
      const db = new Database(join(root, OWNED_DOCKER_LEDGER_FILENAME), { readonly: true })
      expect(db.prepare('SELECT manager_state, manager_epoch, operation_seq FROM ledger_meta').get())
        .toEqual({ manager_state: 'recovery', manager_epoch: 0, operation_seq: 0 })
      db.close()
      expect(ledger.listOperations()).toEqual([])
      ledger.close()
    },
  )

  it('quarantines attempted-unbound absence across restart without redispatch', async () => {
    const { activation, root, ledger, active } = await harness()
    const operation = active.prepare(workerInput())
    let dispatches = 0
    await expect(operation.create('worker', async () => { dispatches += 1; throw new Error('lost') }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
    expect(dispatches).toBe(1)
    await expect(operation.create('worker', async () => { dispatches += 1 }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
    expect(dispatches).toBe(1)
    ledger.close()

    const recoveryLedger = openActivatedOwnedDockerResourceLedger({ root, activation })
    const recoveryDocker = new FakeDocker()
    await expect(reconcileOwnedDockerResources({ ledger: recoveryLedger, docker: recoveryDocker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_CREATE_UNRESOLVED' })
    expect(recoveryLedger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
    recoveryDocker.add(operation.resources[0]!, 'e'.repeat(64))
    await expect(reconcileAndActivate(recoveryLedger, recoveryDocker))
      .resolves.toMatchObject({
        kind: 'reconciled-and-activated', clearedOperations: 1, removedResources: 1,
      })
    expect(recoveryLedger.listOperations()).toEqual([])
    recoveryLedger.close()
  })

  it('binds an exact attempted container from a genuine recovery outcome and redacts the result', async () => {
    const { ledger, docker, operation, recoveryEpoch } = await attemptedRecoveryHarness()
    const objectId = 'e'.repeat(64)

    const recovered = await ledger.recoverAttemptedContainer(
      operation.operationBindingHash,
      async (descriptor, permit) => {
        expect(consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
          permit, ledger, recoveryEpoch,
        )).toBe(descriptor)
        docker.add(descriptor, objectId)
        return mintOwnedDockerAttestedAttemptedContainerRecoveryFoundOutcomeV1(
          permit, docker.resources.get(objectId)!,
        )
      },
    )

    expect(recovered).toEqual({ kind: 'bound' })
    expect(Object.keys(recovered)).toEqual(['kind'])
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId, boundProjectionHashV1: BOUND_PROJECTION_V1.worker,
    })
    expect(docker.calls).toEqual([])
    ledger.close()
  })

  it('allows a fresh permit after not-yet-visible or transport throw without changing the row', async () => {
    const { ledger, operation, recoveryEpoch } = await attemptedRecoveryHarness()
    const permits: unknown[] = []
    let firstOutcome: OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1 | undefined

    await expect(ledger.recoverAttemptedContainer(
      operation.operationBindingHash,
      async (descriptor, permit) => {
        permits.push(permit)
        expect(consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
          permit, ledger, recoveryEpoch,
        )).toBe(descriptor)
        firstOutcome = mintOwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1(permit)
        return firstOutcome
      },
    )).resolves.toEqual({ kind: 'not-yet-visible' })
    expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
    expect(() => consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
      permits[0], ledger, recoveryEpoch,
    )).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))

    await expect(ledger.recoverAttemptedContainer(
      operation.operationBindingHash,
      async (_descriptor, permit) => {
        permits.push(permit)
        throw new Error('read transport failed')
      },
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_DAEMON_AMBIGUOUS' })
    expect(permits[1]).not.toBe(permits[0])
    expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')

    await expect(ledger.recoverAttemptedContainer(
      operation.operationBindingHash,
      async (descriptor, permit) => {
        permits.push(permit)
        expect(consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
          permit, ledger, recoveryEpoch,
        )).toBe(descriptor)
        return mintOwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1(permit)
      },
    )).resolves.toEqual({ kind: 'not-yet-visible' })
    expect(permits[2]).not.toBe(permits[1])

    await expect(ledger.recoverAttemptedContainer(
      operation.operationBindingHash,
      async () => firstOutcome!,
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_INPUT_INVALID' })
    expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
    ledger.close()
  })

  it('accepts only the exact recovery permit once for the exact ledger and epoch', async () => {
    const source = await attemptedRecoveryHarness()
    const foreign = await attemptedRecoveryHarness()
    let captured: unknown

    await expect(source.ledger.recoverAttemptedContainer(
      source.operation.operationBindingHash,
      async (descriptor, permit) => {
        captured = permit
        for (const candidate of [
          { ...permit },
          new Proxy(permit, {}),
          {
            version: 1,
            operationBindingHash: permit.operationBindingHash,
            role: permit.role,
          },
        ]) {
          expect(() => consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
            candidate, source.ledger, source.recoveryEpoch,
          )).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
        }
        expect(consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
          permit, source.ledger, source.recoveryEpoch,
        )).toBe(descriptor)
        expect(() => consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
          permit, source.ledger, source.recoveryEpoch,
        )).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
        return mintOwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1(permit)
      },
    )).resolves.toEqual({ kind: 'not-yet-visible' })
    expect(() => consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
      captured, source.ledger, source.recoveryEpoch,
    )).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))

    await expect(source.ledger.recoverAttemptedContainer(
      source.operation.operationBindingHash,
      async (_descriptor, permit) => {
        consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
          permit, foreign.ledger, foreign.recoveryEpoch,
        )
        throw new Error('unreachable')
      },
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_INPUT_INVALID' })

    await expect(source.ledger.recoverAttemptedContainer(
      source.operation.operationBindingHash,
      async (_descriptor, permit) => {
        consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
          permit, source.ledger, source.recoveryEpoch + 1,
        )
        throw new Error('unreachable')
      },
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_INPUT_INVALID' })
    expect(source.ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
    expect(foreign.ledger.listOperations()[0]!.resources[0]!.phase).toBe('attempted')
    source.ledger.close()
    foreign.ledger.close()
  })

  it.each(['manual', 'spread', 'proxy'] as const)(
    'rejects a %s recovery outcome without binding',
    async variant => {
      const { ledger, docker, operation, recoveryEpoch } = await attemptedRecoveryHarness()
      const objectId = 'e'.repeat(64)

      await expect(ledger.recoverAttemptedContainer(
        operation.operationBindingHash,
        async (descriptor, permit) => {
          if (variant === 'manual') return { version: 1, kind: 'found' } as never
          consumeOwnedDockerAttemptedContainerRecoveryPermitV1(permit, ledger, recoveryEpoch)
          docker.add(descriptor, objectId)
          const genuine = mintOwnedDockerAttestedAttemptedContainerRecoveryFoundOutcomeV1(
            permit, docker.resources.get(objectId)!,
          )
          return (variant === 'spread' ? { ...genuine } : new Proxy(genuine, {})) as never
        },
      )).rejects.toMatchObject({ code: 'OWNED_DOCKER_INPUT_INVALID' })
      expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
        phase: 'attempted', objectId: null, boundProjectionHashV1: null,
      })
      ledger.close()
    },
  )

  it('holds the recovery dispatch barrier and rejects concurrent recovery of the same row', async () => {
    const { ledger, docker, operation, recoveryEpoch } = await attemptedRecoveryHarness()
    const entered = deferred()
    const release = deferred()
    const recovering = ledger.recoverAttemptedContainer(
      operation.operationBindingHash,
      async (descriptor, permit) => {
        consumeOwnedDockerAttemptedContainerRecoveryPermitV1(permit, ledger, recoveryEpoch)
        entered.resolve()
        await release.promise
        return mintOwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1(permit)
      },
    )
    await entered.promise

    expect(() => ledger.close()).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_BUSY' }))
    docker.calls.splice(0)
    await expect(reconcileOwnedDockerResources({ ledger, docker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    await expect(ledger.recoverAttemptedContainer(
      operation.operationBindingHash,
      async () => { throw new Error('must not dispatch') },
    )).rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    expect(docker.calls).toEqual([])

    release.resolve()
    await expect(recovering).resolves.toEqual({ kind: 'not-yet-visible' })
    await expect(ledger.recoverAttemptedContainer(
      operation.operationBindingHash,
      async (_descriptor, permit) => {
        consumeOwnedDockerAttemptedContainerRecoveryPermitV1(permit, ledger, recoveryEpoch)
        return mintOwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1(permit)
      },
    )).resolves.toEqual({ kind: 'not-yet-visible' })
    ledger.close()
  })

  it('invalidates stale active authority in O(1) when a new recovery epoch starts', async () => {
    const { ledger, docker, active } = await harness()
    const next = await reconcileAndActivate(ledger, docker)
    expect(next.activeEpoch.epoch).toBeGreaterThan(active.epoch)
    expect(isOwnedDockerActiveEpoch(active)).toBe(true)
    expect(isOwnedDockerActiveEpoch(next.activeEpoch)).toBe(true)
    const operationsBefore = ledger.listOperations()
    expect(() => active.prepare(workerInput()))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_EPOCH_STALE' }))
    expect(ledger.listOperations()).toEqual(operationsBefore)
    expect(next.activeEpoch.prepare(workerInput()).operationBindingHash).toMatch(/^[a-f0-9]{64}$/)
    ledger.close()
  })

  it('fails closed when the attested endpoint is replaced after activation', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    await operation.create('worker', async descriptor => docker.add(descriptor, 'd'.repeat(64)))
    docker.endpointIdentity = { ...ENDPOINT_IDENTITY, serverVersion: '29.0.0' }
    docker.calls.splice(0)
    await expect(operation.complete()).rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(() => active.prepare(workerInput()))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' }))
    expect(docker.calls).toEqual([])
    expect(docker.resources.has('d'.repeat(64))).toBe(true)
    expect(ledger.listOperations()).toHaveLength(1)

    docker.endpointIdentity = ENDPOINT_IDENTITY
    await expect(operation.complete()).resolves.toMatchObject({ removedResources: 1 })
    ledger.close()
  })

  it('detects endpoint replacement after awaited inspect before trusted use dispatch', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const bound = await operation.create('worker', async descriptor =>
      docker.add(descriptor, 'd'.repeat(64)))
    const entered = deferred()
    const release = deferred()
    docker.inspectEntered = () => entered.resolve()
    docker.inspectBarrier = release.promise
    let dispatched = false
    const using = bound.use(async () => { dispatched = true; return 'unsafe' })
    await entered.promise
    docker.endpointIdentity = { ...ENDPOINT_IDENTITY, serverId: 'replacement-engine' }
    release.resolve()
    await expect(using).rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(dispatched).toBe(false)
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: 'd'.repeat(64),
    })
    ledger.close()
  })

  it('rechecks endpoint after awaited trusted use dispatch before returning its result', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const bound = await operation.create('worker', async descriptor =>
      docker.add(descriptor, 'd'.repeat(64)))
    const entered = deferred()
    const release = deferred()
    const using = bound.use(async () => {
      entered.resolve()
      await release.promise
      return 'must-not-return'
    })
    await entered.promise
    docker.endpointIdentity = { ...ENDPOINT_IDENTITY, serverVersion: '29.0.0' }
    release.resolve()
    await expect(using).rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('bound')
    ledger.close()
  })

  it('post-attests a rejected use dispatch while otherwise preserving its exact error', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const bound = await operation.create('worker', async descriptor =>
      docker.add(descriptor, 'd'.repeat(64)))
    const entered = deferred()
    const release = deferred()
    const callerFailure = new Error('caller-dispatch-failed')
    const using = bound.use(async () => {
      entered.resolve()
      await release.promise
      throw callerFailure
    })
    await entered.promise
    docker.endpointIdentity = { ...ENDPOINT_IDENTITY, serverId: 'replacement-engine' }
    release.resolve()
    await expect(using).rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })

    docker.endpointIdentity = ENDPOINT_IDENTITY
    const unchangedFailure = new Error('unchanged-endpoint-failure')
    await expect(bound.use(async () => { throw unchangedFailure })).rejects.toBe(unchangedFailure)
    expect(ledger.listOperations()[0]!.resources[0]!.phase).toBe('bound')
    ledger.close()
  })

  it('detects endpoint replacement after awaited remove and keeps durable cleanup intent', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    await operation.create('worker', async descriptor => docker.add(descriptor, 'd'.repeat(64)))
    const entered = deferred()
    const release = deferred()
    docker.removeEntered = () => entered.resolve()
    docker.removeBarrier = release.promise
    const completing = operation.complete()
    await entered.promise
    docker.endpointIdentity = { ...ENDPOINT_IDENTITY, endpointBindingHash: '8'.repeat(64) }
    release.resolve()
    await expect(completing).rejects.toMatchObject({ code: 'OWNED_DOCKER_ENDPOINT_MISMATCH' })
    expect(docker.resources.has('d'.repeat(64))).toBe(false)
    expect(ledger.listOperations()[0]!.resources[0]).toMatchObject({
      phase: 'bound', objectId: 'd'.repeat(64),
    })
    docker.endpointIdentity = ENDPOINT_IDENTITY
    docker.removeBarrier = null
    await expect(operation.complete()).resolves.toMatchObject({ clearedOperations: 1 })
    ledger.close()
  })

  it('rejects clone before sequence allocation until a genuine clone projection contract exists', async () => {
    const { root, ledger, active } = await harness()
    expect(() => active.prepare(cloneInput()))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_INPUT_INVALID' }))
    expect(ledger.listOperations()).toEqual([])
    const db = new Database(join(root, OWNED_DOCKER_LEDGER_FILENAME), { readonly: true })
    expect(db.prepare('SELECT operation_seq FROM ledger_meta').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM operations').pluck().get()).toBe(0)
    db.close()
    ledger.close()
  })

  it('keeps the writer lease while create dispatch is in flight and closes after it settles', async () => {
    const { root, activation, ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const entered = deferred()
    const release = deferred()
    const creating = operation.create('worker', async descriptor => {
      docker.add(descriptor, 'd'.repeat(64))
      entered.resolve()
      await release.promise
    })
    await entered.promise
    expect(() => ledger.close()).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_BUSY' }))
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_BUSY' }))
    release.resolve()
    await expect(creating).resolves.toMatchObject({ objectId: 'd'.repeat(64) })
    expect(() => ledger.close()).not.toThrow()
  })

  it('keeps the writer lease while completion is in flight and closes after it settles', async () => {
    const { root, activation, ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    await operation.create('worker', async descriptor => docker.add(descriptor, 'd'.repeat(64)))
    const entered = deferred()
    const release = deferred()
    docker.probeEntered = () => entered.resolve()
    docker.probeBarrier = release.promise
    const completing = operation.complete()
    await entered.promise
    expect(() => ledger.close()).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_BUSY' }))
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_BUSY' }))
    release.resolve()
    await expect(completing).resolves.toMatchObject({ kind: 'completed' })
    expect(() => ledger.close()).not.toThrow()
  })

  it('blocks complete and same-ledger epoch rotation while trusted use is in flight', async () => {
    const { root, activation, ledger, docker, active } = await harness()
    const first = active.prepare(workerInput())
    const firstBound = await first.create('worker', async descriptor =>
      docker.add(descriptor, 'd'.repeat(64)))
    const second = active.prepare(workerInput())
    const entered = deferred()
    const release = deferred()
    const using = firstBound.use(async () => {
      entered.resolve()
      await release.promise
      return 'done'
    })
    await entered.promise
    expect(() => ledger.close()).toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_BUSY' }))
    expect(() => openActivatedOwnedDockerResourceLedger({ root, activation }))
      .toThrowError(expect.objectContaining({ code: 'OWNED_DOCKER_LEDGER_BUSY' }))

    // A different operation remains independent while the first dispatch runs.
    await expect(second.create('worker', async descriptor =>
      docker.add(descriptor, 'e'.repeat(64)))).resolves.toMatchObject({ objectId: 'e'.repeat(64) })
    docker.calls.splice(0)
    await expect(first.complete()).rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    await expect(reconcileOwnedDockerResources({ ledger, docker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    expect(docker.calls.some(call => call === 'probe' || call.startsWith('remove:'))).toBe(false)
    const db = new Database(join(root, OWNED_DOCKER_LEDGER_FILENAME), { readonly: true })
    expect(db.prepare('SELECT manager_state, manager_epoch FROM ledger_meta').get())
      .toEqual({ manager_state: 'active', manager_epoch: active.epoch })
    db.close()

    release.resolve()
    await expect(using).resolves.toBe('done')
    await expect(first.complete()).resolves.toMatchObject({ clearedOperations: 1 })
    ledger.close()
  })

  it('blocks complete and recovery while create dispatch is in flight', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const entered = deferred()
    const release = deferred()
    const creating = operation.create('worker', async descriptor => {
      docker.add(descriptor, 'd'.repeat(64))
      entered.resolve()
      await release.promise
    })
    await entered.promise
    docker.calls.splice(0)
    await expect(operation.complete()).rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    await expect(reconcileOwnedDockerResources({ ledger, docker }))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    expect(docker.calls).toEqual([])
    release.resolve()
    await expect(creating).resolves.toMatchObject({ objectId: 'd'.repeat(64) })
    await expect(operation.complete()).resolves.toMatchObject({ removedResources: 1 })
    ledger.close()
  })

  it('rejects new use/create while the operation is closing and after terminal completion', async () => {
    const { ledger, docker, active } = await harness()
    const operation = active.prepare(workerInput())
    const bound = await operation.create('worker', async descriptor =>
      docker.add(descriptor, 'd'.repeat(64)))
    const probeEntered = deferred()
    const releaseProbe = deferred()
    docker.probeEntered = () => probeEntered.resolve()
    docker.probeBarrier = releaseProbe.promise
    const completing = operation.complete()
    await probeEntered.promise
    await expect(bound.use(async () => 'unsafe'))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    await expect(operation.create('worker', async () => undefined))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_BUSY' })
    releaseProbe.resolve()
    await expect(completing).resolves.toMatchObject({ kind: 'completed' })
    await expect(bound.use(async () => 'unsafe'))
      .rejects.toMatchObject({ code: 'OWNED_DOCKER_LEDGER_CONFLICT' })
    ledger.close()
  })

  it('keeps completed history bounded after 10,000 operations', async () => {
    const { root, ledger, active } = await harness()
    for (let index = 0; index < 10_000; index += 1) {
      const operation = active.prepare(workerInput())
      await operation.complete()
    }
    expect(ledger.listOperations()).toEqual([])
    const db = new Database(join(root, OWNED_DOCKER_LEDGER_FILENAME), { readonly: true })
    expect(db.prepare('SELECT operation_seq FROM ledger_meta').pluck().get()).toBe(10_000)
    expect(db.prepare('SELECT count(*) FROM operations').pluck().get()).toBe(0)
    expect(db.prepare('SELECT count(*) FROM resources').pluck().get()).toBe(0)
    expect(db.prepare(
      "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='completed_operations'",
    ).pluck().get()).toBe(0)
    db.close()
    ledger.close()
  }, 60_000)
})

// Parent-owned startup recovery for the currently supported single-container
// sidecar graph (ADR-0089 / AC-02-92). The manager never exposes the ledger,
// active epoch, endpoint path or a Docker command capability to the child.

import { types as utilTypes } from 'node:util'

import {
  makeNodeDockerEnginePinnedSession,
  makeNodeOwnedDockerEngineAttemptedCreateRecoveryBroker,
  makeNodeOwnedDockerEngineRecoveryBroker,
  type DockerEnginePinnedEndpointIdentityV1,
  type NodeDockerEnginePinnedSessionOptions,
} from './docker-engine-pinned-session.js'
import {
  enterOwnedDockerParentRecoveryAfterPinnedProbe,
  openActivatedOwnedDockerResourceLedger,
  type OwnedDockerAttestedCommandPort,
  type OwnedDockerEndpointIdentityV1,
  type OwnedDockerLedgerActivationV4,
  type OwnedDockerRecoveryLedger,
} from './execution-owned-docker-resources.js'

const managerBrand: unique symbol = Symbol('NodeOwnedDockerParentRecoveryManager')
const managers = new WeakSet<object>()
const ENDPOINT_PROBE_CONTAINER_ID = '0'.repeat(64)

export type OwnedDockerParentRecoveryManagerErrorCode =
  | 'OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID'
  | 'OWNED_DOCKER_PARENT_MANAGER_GRAPH_UNSUPPORTED'
  | 'OWNED_DOCKER_PARENT_MANAGER_NOT_YET_VISIBLE'
  | 'OWNED_DOCKER_PARENT_MANAGER_RECOVERY_FAILED'
  | 'OWNED_DOCKER_PARENT_MANAGER_ALREADY_STARTED'
  | 'OWNED_DOCKER_PARENT_MANAGER_BUSY'
  | 'OWNED_DOCKER_PARENT_MANAGER_CLOSED'

export class OwnedDockerParentRecoveryManagerError extends Error {
  constructor(readonly code: OwnedDockerParentRecoveryManagerErrorCode) {
    super(code)
    this.name = 'OwnedDockerParentRecoveryManagerError'
  }
}

export interface NodeOwnedDockerParentRecoveryManager {
  readonly [managerBrand]: true
  recoverBeforeFirstChild(
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Readonly<{ kind: 'ready' }>>
  isReady(): boolean
  close(): Promise<void>
}

export interface NodeOwnedDockerParentRecoveryManagerOptions {
  readonly root: string
  readonly activation: OwnedDockerLedgerActivationV4
  readonly engine: NodeDockerEnginePinnedSessionOptions
}

function fail(code: OwnedDockerParentRecoveryManagerErrorCode): OwnedDockerParentRecoveryManagerError {
  return new OwnedDockerParentRecoveryManagerError(code)
}

function exactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0) {
    throw fail('OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (required.some(key => !Object.hasOwn(descriptors, key)) ||
    keys.some(key => !required.includes(key) && !optional.includes(key)) ||
    keys.length < required.length) {
    throw fail('OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID')
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]!
    if (!Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined ||
      descriptor.set !== undefined) {
      throw fail('OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID')
    }
    out[key] = descriptor.value
  }
  return out
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw fail('OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID')
  }
  return value
}

function snapshotEndpoint(value: unknown): OwnedDockerEndpointIdentityV1 {
  const input = exactDataRecord(value, [
    'version', 'endpointBindingHash', 'serverId', 'serverVersion', 'apiVersion',
  ])
  if (input['version'] !== 1) throw fail('OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID')
  return Object.freeze({
    version: 1 as const,
    endpointBindingHash: text(input['endpointBindingHash']),
    serverId: text(input['serverId']),
    serverVersion: text(input['serverVersion']),
    apiVersion: text(input['apiVersion']),
  })
}

function snapshotActivation(value: unknown): OwnedDockerLedgerActivationV4 {
  const input = exactDataRecord(value, [
    'version', 'kind', 'installationId', 'databaseId', 'endpointIdentity',
  ])
  if (input['version'] !== 4 || input['kind'] !== 'aisy-owned-docker-ledger-v4') {
    throw fail('OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID')
  }
  return Object.freeze({
    version: 4 as const,
    kind: 'aisy-owned-docker-ledger-v4' as const,
    installationId: text(input['installationId']),
    databaseId: text(input['databaseId']),
    endpointIdentity: snapshotEndpoint(input['endpointIdentity']),
  })
}

function snapshotPinnedEndpoint(value: unknown): DockerEnginePinnedEndpointIdentityV1 {
  const endpoint = snapshotEndpoint(value)
  if (endpoint.apiVersion !== '1.54') {
    throw fail('OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID')
  }
  return Object.freeze({ ...endpoint, apiVersion: '1.54' as const })
}

function optionalBoundedInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw fail('OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID')
  }
  return Number(value)
}

function snapshotEngine(value: unknown): NodeDockerEnginePinnedSessionOptions {
  const input = exactDataRecord(value, ['socketPath', 'endpointIdentity'], [
    'timeoutMs', 'maxResponseBytes', 'maxJsonNodes',
  ])
  const timeoutMs = optionalBoundedInteger(input['timeoutMs'])
  const maxResponseBytes = optionalBoundedInteger(input['maxResponseBytes'])
  const maxJsonNodes = optionalBoundedInteger(input['maxJsonNodes'])
  return Object.freeze({
    socketPath: text(input['socketPath']),
    endpointIdentity: snapshotPinnedEndpoint(input['endpointIdentity']),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    ...(maxJsonNodes === undefined ? {} : { maxJsonNodes }),
  })
}

function signalFrom(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined
  const input = exactDataRecord(value, [], ['signal'])
  const signal = input['signal']
  if (signal === undefined) return undefined
  if (typeof AbortSignal !== 'function' || !(signal instanceof AbortSignal) || utilTypes.isProxy(signal)) {
    throw fail('OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID')
  }
  return signal
}

function endpointEqual(a: OwnedDockerEndpointIdentityV1, b: OwnedDockerEndpointIdentityV1): boolean {
  return a.version === b.version && a.endpointBindingHash === b.endpointBindingHash &&
    a.serverId === b.serverId && a.serverVersion === b.serverVersion &&
    a.apiVersion === b.apiVersion
}

function endpointOnlyPort(endpointIdentity: OwnedDockerEndpointIdentityV1): OwnedDockerAttestedCommandPort {
  const ambiguous = async () => ({ kind: 'ambiguous' as const })
  return Object.freeze({
    endpointIdentity,
    probe: async () => ({ kind: 'ambiguous' as const }),
    scanInstallation: ambiguous,
    inspectById: ambiguous,
    inspectByName: ambiguous,
    removeById: ambiguous,
  })
}

export function isNodeOwnedDockerParentRecoveryManager(
  value: unknown,
): value is NodeOwnedDockerParentRecoveryManager {
  return typeof value === 'object' && value !== null && !utilTypes.isProxy(value) &&
    managers.has(value)
}

export function makeNodeOwnedDockerParentRecoveryManager(
  options: NodeOwnedDockerParentRecoveryManagerOptions,
): NodeOwnedDockerParentRecoveryManager {
  const input = exactDataRecord(options, ['root', 'activation', 'engine'])
  const root = text(input['root'])
  const activation = snapshotActivation(input['activation'])
  const engine = snapshotEngine(input['engine'])
  if (!endpointEqual(activation.endpointIdentity, engine.endpointIdentity)) {
    throw fail('OWNED_DOCKER_PARENT_MANAGER_INPUT_INVALID')
  }

  let lifecycle: 'open' | 'recovering' | 'ready' | 'failed' | 'closed' = 'open'
  let heldLedger: OwnedDockerRecoveryLedger | null = null

  const closeLedger = (): void => {
    const ledger = heldLedger
    if (ledger === null) return
    ledger.close()
    heldLedger = null
  }

  const manager: NodeOwnedDockerParentRecoveryManager = {
    [managerBrand]: true as const,
    isReady: () => lifecycle === 'ready' && heldLedger !== null,
    async recoverBeforeFirstChild(rawOptions) {
      if (lifecycle === 'recovering') throw fail('OWNED_DOCKER_PARENT_MANAGER_BUSY')
      if (lifecycle === 'ready') throw fail('OWNED_DOCKER_PARENT_MANAGER_ALREADY_STARTED')
      if (lifecycle === 'closed' || lifecycle === 'failed') {
        throw fail('OWNED_DOCKER_PARENT_MANAGER_CLOSED')
      }
      const signal = signalFrom(rawOptions)
      const requestOptions = signal === undefined ? undefined : Object.freeze({ signal })
      lifecycle = 'recovering'
      let ledger: OwnedDockerRecoveryLedger | null = null
      try {
        ledger = openActivatedOwnedDockerResourceLedger({ root, activation })
        heldLedger = ledger
        const endpointProbe = makeNodeDockerEnginePinnedSession(engine)
        try {
          // The result is irrelevant: version/info and this bounded GET prove
          // that the configured pinned endpoint is reachable. Recovery state
          // is read only after the session has completed and drained.
          await endpointProbe.inspectContainer(ENDPOINT_PROBE_CONTAINER_ID, requestOptions)
        } finally {
          await endpointProbe.close()
        }
        enterOwnedDockerParentRecoveryAfterPinnedProbe(ledger, engine.endpointIdentity)
        const operations = ledger.listOperations()
        if (operations.length > 1) {
          throw fail('OWNED_DOCKER_PARENT_MANAGER_GRAPH_UNSUPPORTED')
        }
        const operation = operations[0]
        if (operation !== undefined) {
          if (operation.resources.length !== 1) {
            throw fail('OWNED_DOCKER_PARENT_MANAGER_GRAPH_UNSUPPORTED')
          }
          const resource = operation.resources[0]!
          if (resource.role !== 'worker' || resource.resourceKind !== 'container') {
            throw fail('OWNED_DOCKER_PARENT_MANAGER_GRAPH_UNSUPPORTED')
          }
          if (resource.phase === 'prepared') {
            ledger.recoverPreparedOperation(operation.operationBindingHash)
          } else if (resource.phase === 'attempted') {
            const broker = makeNodeOwnedDockerEngineAttemptedCreateRecoveryBroker({
              ...engine,
              authority: ledger,
            })
            try {
              const recovered = await ledger.recoverAttemptedContainer(
                operation.operationBindingHash,
                (_descriptor, permit) => broker.inspectExact(permit, requestOptions),
              )
              if (recovered.kind === 'not-yet-visible') {
                throw fail('OWNED_DOCKER_PARENT_MANAGER_NOT_YET_VISIBLE')
              }
            } finally {
              await broker.close()
            }
          }
          const current = ledger.listOperations()[0]
          if (current !== undefined) {
            const currentResource = current.resources[0]
            if (current.resources.length !== 1 || currentResource?.role !== 'worker' ||
              currentResource.resourceKind !== 'container' || currentResource.phase !== 'bound') {
              throw fail('OWNED_DOCKER_PARENT_MANAGER_GRAPH_UNSUPPORTED')
            }
            const broker = makeNodeOwnedDockerEngineRecoveryBroker({ ...engine, authority: ledger })
            try {
              await ledger.recoverBoundContainer(
                current.operationBindingHash,
                (_expected, permit) => broker.removeBoundContainer(permit, requestOptions),
              )
            } finally {
              await broker.close()
            }
          }
        }
        if (ledger.listOperations().length !== 0) {
          throw fail('OWNED_DOCKER_PARENT_MANAGER_RECOVERY_FAILED')
        }
        const activationBroker = makeNodeOwnedDockerEngineRecoveryBroker({
          ...engine,
          authority: ledger,
        })
        try {
          await ledger.activateAfterInstallationZero(
            endpointOnlyPort(activation.endpointIdentity),
            activationBroker,
            requestOptions,
          )
        } finally {
          await activationBroker.close()
        }
        lifecycle = 'ready'
        return Object.freeze({ kind: 'ready' as const })
      } catch (error) {
        lifecycle = 'failed'
        try { closeLedger() } catch { /* the stable recovery refusal wins */ }
        if (error instanceof OwnedDockerParentRecoveryManagerError) throw error
        throw fail('OWNED_DOCKER_PARENT_MANAGER_RECOVERY_FAILED')
      }
    },
    async close() {
      if (lifecycle === 'closed') return
      if (lifecycle === 'recovering') throw fail('OWNED_DOCKER_PARENT_MANAGER_BUSY')
      closeLedger()
      lifecycle = 'closed'
    },
  }
  Object.freeze(manager)
  managers.add(manager)
  return manager
}

import { isAbsolute, join, normalize } from 'node:path'
import { types as utilTypes } from 'node:util'

import {
  isRestrictedCloneDockerVersionCompatible,
  type OwnedDockerRecoveryReadinessProbe,
} from '@aisy/core'

import {
  computeDockerEngineUnixSocketBindingHash,
  makeNodeDockerEnginePinnedSession,
  PINNED_DOCKER_ENGINE_API_IDENTITY,
} from './docker-engine-pinned-session.js'
import {
  initializeOwnedDockerResourceLedger,
  loadOwnedDockerResourceLedgerActivation,
} from './execution-owned-docker-resources.js'
import {
  makeNodeOwnedDockerParentRecoveryManager,
  type NodeOwnedDockerParentRecoveryManager,
} from './owned-docker-parent-recovery-manager.js'

export const OWNED_DOCKER_SUPERVISOR_REQUIRED = 'OWNED_DOCKER_SUPERVISOR_REQUIRED' as const
export const OWNED_DOCKER_PRODUCTION_CONFIG_INVALID =
  'OWNED_DOCKER_PRODUCTION_CONFIG_INVALID' as const

const ENABLE = 'AISY_OWNED_DOCKER_RECOVERY'
const SOCKET = 'AISY_OWNED_DOCKER_SOCKET'
const INSTALLATION = 'AISY_OWNED_DOCKER_INSTALLATION_ID'
const SERVER_ID = 'AISY_OWNED_DOCKER_SERVER_ID'
const SERVER_VERSION = 'AISY_OWNED_DOCKER_SERVER_VERSION'
const CONFIG_KEYS = [SOCKET, INSTALLATION, SERVER_ID, SERVER_VERSION] as const
const HASH = /^[a-f0-9]{64}$/
const SERVER_ID_VALUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/
const SERVER_VERSION_VALUE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?$/
const DOCTOR_PROBE_CONTAINER_ID = '0'.repeat(64)

export class OwnedDockerProductionRecoveryError extends Error {
  constructor(readonly code: typeof OWNED_DOCKER_PRODUCTION_CONFIG_INVALID) {
    super(code)
    this.name = 'OwnedDockerProductionRecoveryError'
  }
}

function fail(): never {
  throw new OwnedDockerProductionRecoveryError(OWNED_DOCKER_PRODUCTION_CONFIG_INVALID)
}

function ownString(source: unknown, key: string): string | undefined {
  try {
    if (typeof source !== 'object' || source === null || Array.isArray(source) ||
      utilTypes.isProxy(source)) fail()
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined) return undefined
    if (!('value' in descriptor) || descriptor.enumerable !== true ||
      typeof descriptor.value !== 'string') fail()
    return descriptor.value
  } catch (error) {
    if (error instanceof OwnedDockerProductionRecoveryError) throw error
    fail()
  }
}

interface ProductionConfig {
  readonly socketPath: string
  readonly installationId: string
  readonly serverId: string
  readonly serverVersion: string
}

function snapshotConfig(source: unknown): ProductionConfig | null {
  const enabled = ownString(source, ENABLE)
  const values = CONFIG_KEYS.map(key => ownString(source, key))
  if (enabled === undefined || enabled === '' || enabled === '0') {
    if (values.some(value => value !== undefined && value !== '')) fail()
    return null
  }
  if (enabled !== '1' || values.some(value => value === undefined || value === '')) fail()
  const [socketPath, installationId, serverId, serverVersion] = values as [
    string, string, string, string,
  ]
  if (!HASH.test(installationId) || !isAbsolute(socketPath) || normalize(socketPath) !== socketPath ||
    socketPath === '/' || socketPath.endsWith('/') || socketPath.includes('\0') ||
    !SERVER_ID_VALUE.test(serverId) || !SERVER_VERSION_VALUE.test(serverVersion) ||
    !isRestrictedCloneDockerVersionCompatible(serverVersion)) fail()
  return Object.freeze({ socketPath, installationId, serverId, serverVersion })
}

/** Pure selector used by the CLI to keep this authority out of direct run. */
export function ownedDockerProductionRecoveryRequested(source: unknown): boolean {
  return snapshotConfig(source) !== null
}

function snapshotInput(input: unknown): Readonly<{ source: unknown; stateRoot: string }> {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      utilTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) fail()
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length !== 2 || !keys.includes('source') || !keys.includes('stateRoot')) fail()
    const source = descriptors['source']
    const stateRoot = descriptors['stateRoot']
    if (source === undefined || stateRoot === undefined || !('value' in source) ||
      !('value' in stateRoot) || source.enumerable !== true || stateRoot.enumerable !== true ||
      typeof stateRoot.value !== 'string' || stateRoot.value.length === 0 ||
      stateRoot.value.includes('\0')) fail()
    return Object.freeze({ source: source.value, stateRoot: stateRoot.value })
  } catch (error) {
    if (error instanceof OwnedDockerProductionRecoveryError) throw error
    fail()
  }
}

function configuredIdentity(config: ProductionConfig) {
  return Object.freeze({
    version: 1 as const,
    endpointBindingHash: computeDockerEngineUnixSocketBindingHash(config.socketPath),
    serverId: config.serverId,
    serverVersion: config.serverVersion,
    apiVersion: PINNED_DOCKER_ENGINE_API_IDENTITY,
  })
}

/** Explicit offline enrollment. It never opens a supervisor or child runtime. */
export function enrollNodeOwnedDockerProductionRecovery(input: Readonly<{
  source: unknown
  stateRoot: string
}>): void {
  const snapshot = snapshotInput(input)
  const config = snapshotConfig(snapshot.source)
  if (config === null) fail()
  initializeOwnedDockerResourceLedger({
    root: join(snapshot.stateRoot, 'owned-docker-v4'),
    installationId: config.installationId,
    endpointIdentity: configuredIdentity(config),
  })
}

/**
 * Production parent-only recovery composition. Disabled configuration performs
 * no filesystem or Docker I/O. The returned manager still cannot create or use
 * a sidecar and exposes no active epoch to the supervised child.
 */
export function makeNodeOwnedDockerProductionRecovery(input: Readonly<{
  source: unknown
  stateRoot: string
}>): NodeOwnedDockerParentRecoveryManager | null {
  const snapshot = snapshotInput(input)
  const config = snapshotConfig(snapshot.source)
  if (config === null) return null
  const endpointIdentity = configuredIdentity(config)
  const root = join(snapshot.stateRoot, 'owned-docker-v4')
  const activation = loadOwnedDockerResourceLedgerActivation({
    root,
    installationId: config.installationId,
    endpointIdentity,
  })
  return makeNodeOwnedDockerParentRecoveryManager({
    root,
    activation,
    engine: { socketPath: config.socketPath, endpointIdentity },
  })
}

/** Read-only doctor projection. It never enrolls, repairs or opens a writer lease. */
export function makeNodeOwnedDockerProductionRecoveryDoctorProbe(input: Readonly<{
  source: unknown
  stateRoot: string
}>): OwnedDockerRecoveryReadinessProbe {
  let snapshot: Readonly<{ source: unknown; stateRoot: string }>
  let config: ProductionConfig | null
  try {
    snapshot = snapshotInput(input)
    config = snapshotConfig(snapshot.source)
  } catch {
    return Object.freeze({
      inspect: async () => Object.freeze({ state: 'invalid-config' as const }),
    })
  }
  if (config === null) {
    return Object.freeze({
      inspect: async () => Object.freeze({ state: 'disabled' as const }),
    })
  }
  return Object.freeze({
    async inspect() {
      let endpointIdentity: ReturnType<typeof configuredIdentity>
      try {
        endpointIdentity = configuredIdentity(config)
      } catch {
        return Object.freeze({ state: 'daemon-unavailable' as const })
      }
      try {
        loadOwnedDockerResourceLedgerActivation({
          root: join(snapshot.stateRoot, 'owned-docker-v4'),
          installationId: config.installationId,
          endpointIdentity,
        })
      } catch {
        return Object.freeze({ state: 'ledger-unavailable' as const })
      }

      try {
        const session = makeNodeDockerEnginePinnedSession({
          socketPath: config.socketPath,
          endpointIdentity,
        })
        try {
          await session.inspectContainer(DOCTOR_PROBE_CONTAINER_ID)
        } finally {
          await session.close()
        }
        return Object.freeze({ state: 'ready' as const })
      } catch {
        return Object.freeze({ state: 'daemon-unavailable' as const })
      }
    },
  })
}

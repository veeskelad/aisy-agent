// Durable ownership ledger and fail-closed reconciliation protocol for
// daemon-owned sidecar resources (ADR-0089). Concrete Docker wiring remains
// dormant until runtime composition explicitly activates it.

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { types as utilTypes } from 'node:util'

import Database from 'better-sqlite3'

import {
  acquirePrivateSqliteLease,
  PrivateSqliteLeaseError,
  type PrivateSqliteLease,
  type PrivateSqliteLeaseProfile,
} from './private-sqlite-lease.js'

export const OWNED_DOCKER_LEDGER_FILENAME = 'owned-docker-resources.sqlite3'
export const OWNED_DOCKER_LEDGER_ROOT_DIRNAME = '.owned-docker-resources'

const APPLICATION_ID = 0x4144_4c52
const HASH = /^[a-f0-9]{64}$/
const RESOURCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/
const OBJECT_ID = /^[a-f0-9]{64}$/
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/
const SERVER_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?$/
const API_VERSION = /^1\.[0-9]{1,3}$/
const MAX_SCAN_RESOURCES = 4096
const MAX_OPERATION_SEQUENCE = Number.MAX_SAFE_INTEGER
const activeEpochBrand: unique symbol = Symbol('aisy.owned-docker-active-epoch')
const operationHandleBrand: unique symbol = Symbol('aisy.owned-docker-operation-handle')
const attemptedCreatePermitBrand: unique symbol = Symbol('aisy.owned-docker-attempted-create-permit')
const attemptedContainerRecoveryPermitBrand: unique symbol = Symbol(
  'aisy.owned-docker-attempted-container-recovery-permit',
)
const attemptedContainerRecoveryOutcomeBrand: unique symbol = Symbol(
  'aisy.owned-docker-attempted-container-recovery-outcome',
)
const boundContainerUsePermitBrand: unique symbol = Symbol(
  'aisy.owned-docker-bound-container-use-permit',
)
const recoveryBoundContainerCleanupPermitBrand: unique symbol = Symbol(
  'aisy.owned-docker-recovery-bound-container-cleanup-permit',
)
const recoveryBoundContainerCleanupOutcomeBrand: unique symbol = Symbol(
  'aisy.owned-docker-recovery-bound-container-cleanup-outcome',
)
const recoveryActivationPermitBrand: unique symbol = Symbol(
  'aisy.owned-docker-recovery-activation-permit',
)
const recoveryActivationOutcomeBrand: unique symbol = Symbol(
  'aisy.owned-docker-recovery-activation-outcome',
)

const META_SCHEMA = "CREATE TABLE ledger_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 4), database_id TEXT NOT NULL CHECK (length(database_id) = 64), installation_id TEXT NOT NULL CHECK (length(installation_id) = 64), endpoint_binding_hash TEXT NOT NULL CHECK (length(endpoint_binding_hash) = 64), server_id TEXT NOT NULL, server_version TEXT NOT NULL, api_version TEXT NOT NULL, manager_state TEXT NOT NULL CHECK (manager_state IN ('recovery', 'active')), manager_epoch INTEGER NOT NULL CHECK (manager_epoch >= 0), operation_seq INTEGER NOT NULL CHECK (operation_seq >= 0), integrity_hash TEXT NOT NULL CHECK (length(integrity_hash) = 64))"
const OPERATION_SCHEMA = "CREATE TABLE operations (operation_seq INTEGER PRIMARY KEY CHECK (operation_seq > 0), operation_binding_hash TEXT NOT NULL UNIQUE CHECK (length(operation_binding_hash) = 64), manager_epoch INTEGER NOT NULL CHECK (manager_epoch > 0), owner_binding_hash TEXT NOT NULL CHECK (length(owner_binding_hash) = 64), session_binding_hash TEXT NOT NULL CHECK (length(session_binding_hash) = 64), sidecar_kind TEXT NOT NULL CHECK (sidecar_kind IN ('restricted-clone', 'whisper', 'lease-bound-docker-bash')), policy_hash TEXT NOT NULL CHECK (length(policy_hash) = 64), integrity_hash TEXT NOT NULL CHECK (length(integrity_hash) = 64))"
const RESOURCE_SCHEMA = "CREATE TABLE resources (operation_seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('worker', 'gateway', 'network')), resource_kind TEXT NOT NULL CHECK (resource_kind IN ('container', 'network')), resource_name TEXT NOT NULL UNIQUE, create_projection_contract TEXT NOT NULL CHECK (create_projection_contract IN ('container-selected-v2', 'network-full-v1')), create_projection_hash TEXT NOT NULL CHECK (length(create_projection_hash) = 64), bound_projection_hash_v1 TEXT CHECK (bound_projection_hash_v1 IS NULL OR length(bound_projection_hash_v1) = 64), phase TEXT NOT NULL CHECK (phase IN ('prepared', 'attempted', 'bound')), integrity_hash TEXT NOT NULL CHECK (length(integrity_hash) = 64), object_id TEXT UNIQUE, object_integrity_hash TEXT, CHECK ((resource_kind = 'container' AND create_projection_contract = 'container-selected-v2') OR (resource_kind = 'network' AND create_projection_contract = 'network-full-v1')), CHECK ((phase = 'bound' AND bound_projection_hash_v1 IS NOT NULL AND object_id IS NOT NULL AND object_integrity_hash IS NOT NULL) OR (phase IN ('prepared', 'attempted') AND bound_projection_hash_v1 IS NULL AND object_id IS NULL AND object_integrity_hash IS NULL)), PRIMARY KEY (operation_seq, role), FOREIGN KEY (operation_seq) REFERENCES operations(operation_seq) ON DELETE CASCADE)"
const WRITER_SCHEMA = "CREATE TABLE lease_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), role TEXT NOT NULL CHECK (role = 'owned-docker-ledger-writer'), schema_version INTEGER NOT NULL CHECK (schema_version = 1), database_id TEXT NOT NULL CHECK (length(database_id) = 64))"
const WRITER_PROFILE: PrivateSqliteLeaseProfile = {
  role: 'owned-docker-ledger-writer',
  filename: 'writer.sqlite3',
  applicationId: 0x4144_4c57,
  userVersion: 1,
  exactSchemaSql: WRITER_SCHEMA,
}

export type OwnedDockerSidecarKind =
  | 'restricted-clone'
  | 'whisper'
  | 'lease-bound-docker-bash'
export type OwnedDockerResourceKind = 'container' | 'network'
export type OwnedDockerResourceRole = 'worker' | 'gateway' | 'network'

export interface OwnedDockerLedgerActivationV2 {
  readonly version: 2
  readonly kind: 'aisy-owned-docker-ledger-v2'
  readonly installationId: string
  readonly databaseId: string
}

export interface OwnedDockerEndpointIdentityV1 {
  readonly version: 1
  readonly endpointBindingHash: string
  readonly serverId: string
  readonly serverVersion: string
  readonly apiVersion: string
}

export interface OwnedDockerLedgerActivationV3 {
  readonly version: 3
  readonly kind: 'aisy-owned-docker-ledger-v3'
  readonly installationId: string
  readonly databaseId: string
  readonly endpointIdentity: OwnedDockerEndpointIdentityV1
}

export interface OwnedDockerLedgerActivationV4 {
  readonly version: 4
  readonly kind: 'aisy-owned-docker-ledger-v4'
  readonly installationId: string
  readonly databaseId: string
  readonly endpointIdentity: OwnedDockerEndpointIdentityV1
}

/** Kept only so callers can explicitly reject an old offline artifact. */
export interface OwnedDockerLedgerActivationV1 {
  readonly version: 1
  readonly kind: 'aisy-owned-docker-ledger-v1'
  readonly installationId: string
  readonly databaseId: string
}

export interface OwnedDockerLabelsV1 {
  readonly version: '1'
  readonly installationId: string
  readonly ownerBindingHash: string
  readonly sessionBindingHash: string
  readonly operationBindingHash: string
  readonly sidecarKind: OwnedDockerSidecarKind
  readonly role: OwnedDockerResourceRole
  readonly policyHash: string
}

export type OwnedDockerCreateProjectionContractV1 =
  | 'container-selected-v2'
  | 'network-full-v1'

/** Legacy full-inspect evidence. Its v1 projectionHash meaning is immutable. */
export interface OwnedDockerObservedResourceV1 {
  readonly version: 1
  readonly objectId: string
  readonly resourceKind: OwnedDockerResourceKind
  readonly name: string
  readonly labels: OwnedDockerLabelsV1
  readonly projectionHash: string
  readonly networkEndpointCount: number | null
}

export interface OwnedDockerObservedResourceV2 {
  readonly version: 2
  readonly objectId: string
  readonly resourceKind: OwnedDockerResourceKind
  readonly name: string
  readonly labels: OwnedDockerLabelsV1
  readonly createProjectionContract: OwnedDockerCreateProjectionContractV1
  readonly createProjectionHash: string
  readonly projectionHashV1: string
  readonly networkEndpointCount: number | null
}

export type OwnedDockerProbeResult =
  | { readonly kind: 'compatible' }
  | { readonly kind: 'incompatible' }
  | { readonly kind: 'ambiguous' }
export type OwnedDockerScanResult =
  | { readonly kind: 'ok'; readonly resources: readonly OwnedDockerObservedResourceV2[] }
  | { readonly kind: 'ambiguous' }
export type OwnedDockerInspectResult =
  | { readonly kind: 'found'; readonly resource: OwnedDockerObservedResourceV2 }
  | { readonly kind: 'absent' }
  | { readonly kind: 'ambiguous' }
export type OwnedDockerRemoveResult =
  | { readonly kind: 'removed' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'ambiguous' }

/**
 * Semantic port: adapters must use argv, bounded output/time, and exact labels.
 * Every method must execute on the same pinned, attested endpoint generation
 * exposed by its composed OwnedDockerAttestedCommandPort. A static identity
 * value alone is not proof that an individual command used that generation.
 */
export interface OwnedDockerCommandPort {
  probe(): Promise<OwnedDockerProbeResult>
  scanInstallation(installationId: string): Promise<OwnedDockerScanResult>
  inspectById(input: Readonly<{
    resourceKind: OwnedDockerResourceKind
    objectId: string
  }>): Promise<OwnedDockerInspectResult>
  inspectByName(input: Readonly<{
    resourceKind: OwnedDockerResourceKind
    name: string
  }>): Promise<OwnedDockerInspectResult>
  removeById(input: Readonly<{
    resourceKind: OwnedDockerResourceKind
    objectId: string
  }>): Promise<OwnedDockerRemoveResult>
}

export interface OwnedDockerAttestedCommandPort extends OwnedDockerCommandPort {
  readonly endpointIdentity: OwnedDockerEndpointIdentityV1
}

export type OwnedDockerResourceErrorCode =
  | 'OWNED_DOCKER_INPUT_INVALID'
  | 'OWNED_DOCKER_LEDGER_MISSING'
  | 'OWNED_DOCKER_LEDGER_UNSAFE'
  | 'OWNED_DOCKER_LEDGER_CORRUPT'
  | 'OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED'
  | 'OWNED_DOCKER_LEDGER_BUSY'
  | 'OWNED_DOCKER_LEDGER_UNAVAILABLE'
  | 'OWNED_DOCKER_LEDGER_CONFLICT'
  | 'OWNED_DOCKER_EPOCH_STALE'
  | 'OWNED_DOCKER_RECOVERY_REQUIRED'
  | 'OWNED_DOCKER_ENDPOINT_MISMATCH'
  | 'OWNED_DOCKER_CREATE_UNRESOLVED'
  | 'OWNED_DOCKER_DAEMON_AMBIGUOUS'
  | 'OWNED_DOCKER_DAEMON_INCOMPATIBLE'
  | 'OWNED_DOCKER_OWNERSHIP_UNPROVEN'
  | 'OWNED_DOCKER_REMOVAL_AMBIGUOUS'

export class OwnedDockerResourceError extends Error {
  constructor(readonly code: OwnedDockerResourceErrorCode) {
    super(code)
    this.name = 'OwnedDockerResourceError'
  }
}

export interface OwnedDockerCoordinatorResourceCreatePlanV2 {
  readonly version: 2
  readonly role: OwnedDockerResourceRole
  readonly resourceKind: OwnedDockerResourceKind
  readonly createProjectionContract: OwnedDockerCreateProjectionContractV1
  readonly createProjectionHash: string
}

/** Legacy v3 prepare artifact. It is never accepted by the v4 coordinator. */
export interface OwnedDockerCoordinatorResourcePlanV1 {
  readonly version: 1
  readonly role: OwnedDockerResourceRole
  readonly resourceKind: OwnedDockerResourceKind
  readonly projectionHash: string
}

export interface OwnedDockerCoordinatorPrepareInputV1 {
  readonly version: 1
  readonly sidecarKind: OwnedDockerSidecarKind
  readonly policyHash: string
  readonly resources: readonly OwnedDockerCoordinatorResourcePlanV1[]
}

export interface OwnedDockerCoordinatorPrepareInputV2 {
  readonly version: 2
  readonly sidecarKind: OwnedDockerSidecarKind
  readonly policyHash: string
  readonly resources: readonly OwnedDockerCoordinatorResourceCreatePlanV2[]
}

export interface OwnedDockerCreateDescriptorV2 {
  readonly version: 2
  readonly operationBindingHash: string
  readonly role: OwnedDockerResourceRole
  readonly resourceKind: OwnedDockerResourceKind
  readonly name: string
  readonly labels: OwnedDockerLabelsV1
  readonly createProjectionContract: OwnedDockerCreateProjectionContractV1
  readonly createProjectionHash: string
}

export interface OwnedDockerCreateDescriptorV1 {
  readonly version: 1
  readonly operationBindingHash: string
  readonly role: OwnedDockerResourceRole
  readonly resourceKind: OwnedDockerResourceKind
  readonly name: string
  readonly labels: OwnedDockerLabelsV1
  readonly projectionHash: string
}

export type OwnedDockerAttestedCreateDispatchOutcomeV1 = Readonly<{
  readonly kind: 'attested-created'
  readonly observed: OwnedDockerObservedResourceV2
}>

export type OwnedDockerCreateDispatchOutcomeV1 =
  | OwnedDockerAttestedCreateDispatchOutcomeV1
  | Readonly<{
    readonly kind: 'create-ambiguous'
  }>

export interface OwnedDockerAttemptedCreatePermitV1 {
  readonly [attemptedCreatePermitBrand]: true
  readonly version: 1
  readonly operationBindingHash: string
  readonly role: OwnedDockerResourceRole
}

export interface OwnedDockerAttemptedContainerRecoveryPermitV1 {
  readonly [attemptedContainerRecoveryPermitBrand]: true
  readonly version: 1
  readonly operationBindingHash: string
  readonly role: 'worker'
}

export interface OwnedDockerAttestedAttemptedContainerRecoveryFoundOutcomeV1 {
  readonly [attemptedContainerRecoveryOutcomeBrand]: true
  readonly version: 1
  readonly kind: 'found'
}

export interface OwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1 {
  readonly [attemptedContainerRecoveryOutcomeBrand]: true
  readonly version: 1
  readonly kind: 'not-yet-visible'
}

export type OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1 =
  | OwnedDockerAttestedAttemptedContainerRecoveryFoundOutcomeV1
  | OwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1

export type OwnedDockerAttemptedContainerRecoveryResult = Readonly<{
  readonly kind: 'bound' | 'not-yet-visible'
}>

export type OwnedDockerPreparedOperationRecoveryResult = Readonly<{
  readonly kind: 'completed'
  readonly clearedOperations: 1
}>

export interface OwnedDockerBoundUseDescriptorV2 extends OwnedDockerCreateDescriptorV2 {
  readonly objectId: string
  readonly boundProjectionHashV1: string
}

export interface OwnedDockerBoundContainerUsePermitV1 {
  readonly [boundContainerUsePermitBrand]: true
  readonly version: 1
  readonly operationBindingHash: string
  readonly role: OwnedDockerResourceRole
  readonly objectId: string
}

export interface OwnedDockerRecoveryBoundContainerCleanupPermitV1 {
  readonly [recoveryBoundContainerCleanupPermitBrand]: true
  readonly version: 1
  readonly operationBindingHash: string
  readonly role: 'worker'
  readonly objectId: string
}

export interface OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1 {
  readonly [recoveryBoundContainerCleanupOutcomeBrand]: true
  readonly version: 1
  readonly kind: 'removed' | 'absent'
}

export interface OwnedDockerRecoveryBoundContainerCleanupResult {
  readonly kind: 'completed'
  readonly clearedOperations: 1
  readonly removedResources: 0 | 1
}

export interface OwnedDockerRecoveryActivationPermitV1 {
  readonly [recoveryActivationPermitBrand]: true
  readonly version: 1
}

export interface OwnedDockerAttestedRecoveryActivationOutcomeV1 {
  readonly [recoveryActivationOutcomeBrand]: true
  readonly version: 1
  readonly kind: 'installation-zero'
}

export interface OwnedDockerBoundResourceHandle {
  readonly operationBindingHash: string
  readonly role: OwnedDockerResourceRole
  readonly objectId: string
  use<T>(dispatch: (descriptor: OwnedDockerBoundUseDescriptorV2) => Promise<T>): Promise<T>
  useContainer<T>(dispatch: (
    descriptor: OwnedDockerBoundUseDescriptorV2,
    permit: OwnedDockerBoundContainerUsePermitV1,
  ) => Promise<T>): Promise<T>
}

export interface OwnedDockerOperationHandle {
  readonly [operationHandleBrand]: true
  readonly operationBindingHash: string
  readonly resources: readonly OwnedDockerCreateDescriptorV2[]
  create(
    role: OwnedDockerResourceRole,
    dispatch: (
      descriptor: OwnedDockerCreateDescriptorV2,
      permit: OwnedDockerAttemptedCreatePermitV1,
    ) => Promise<void | OwnedDockerCreateDispatchOutcomeV1>,
  ): Promise<OwnedDockerBoundResourceHandle>
  complete(): Promise<OwnedDockerScopedCompletionResult>
}

export interface OwnedDockerActiveEpoch {
  readonly [activeEpochBrand]: true
  readonly epoch: number
  prepare(input: OwnedDockerCoordinatorPrepareInputV2): OwnedDockerOperationHandle
}

export interface OwnedDockerRecoveryLedger {
  readonly activation: OwnedDockerLedgerActivationV4
  readonly mode: 'recovery'
  listOperations(): readonly OwnedDockerLedgerOperationV4[]
  recoverPreparedOperation(
    operationBindingHash: string,
  ): OwnedDockerPreparedOperationRecoveryResult
  recoverAttemptedContainer(
    operationBindingHash: string,
    dispatch: (
      descriptor: OwnedDockerCreateDescriptorV2,
      permit: OwnedDockerAttemptedContainerRecoveryPermitV1,
    ) => Promise<OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1>,
  ): Promise<OwnedDockerAttemptedContainerRecoveryResult>
  recoverBoundContainer(
    operationBindingHash: string,
    dispatch: (
      expected: OwnedDockerObservedResourceV2,
      permit: OwnedDockerRecoveryBoundContainerCleanupPermitV1,
    ) => Promise<OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1>,
  ): Promise<OwnedDockerRecoveryBoundContainerCleanupResult>
  activateAfterInstallationZero(
    docker: OwnedDockerAttestedCommandPort,
    broker: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<OwnedDockerRecoveryResult>
  assertOwned(): void
  close(): void
}

export interface OwnedDockerScopedCompletionResult {
  readonly kind: 'completed'
  readonly clearedOperations: number
  readonly removedResources: number
}

export interface OwnedDockerRecoveryResult {
  readonly kind: 'reconciled-and-activated'
  readonly clearedOperations: number
  readonly removedResources: number
  readonly activeEpoch: OwnedDockerActiveEpoch
}

export interface OwnedDockerLedgerResourceV4 extends OwnedDockerCoordinatorResourceCreatePlanV2 {
  readonly name: string
  readonly phase: 'prepared' | 'attempted' | 'bound'
  readonly objectId: string | null
  readonly boundProjectionHashV1: string | null
}

export interface OwnedDockerLedgerResourceV3 extends OwnedDockerCoordinatorResourcePlanV1 {
  readonly name: string
  readonly phase: 'prepared' | 'attempted' | 'bound'
  readonly objectId: string | null
}

export interface OwnedDockerLedgerOperationV3 {
  readonly version: 3
  readonly operationSequence: number
  readonly managerEpoch: number
  readonly installationId: string
  readonly ownerBindingHash: string
  readonly sessionBindingHash: string
  readonly operationBindingHash: string
  readonly sidecarKind: OwnedDockerSidecarKind
  readonly policyHash: string
  readonly resources: readonly OwnedDockerLedgerResourceV3[]
}

export interface OwnedDockerLedgerOperationV4 {
  readonly version: 4
  readonly operationSequence: number
  readonly managerEpoch: number
  readonly installationId: string
  readonly ownerBindingHash: string
  readonly sessionBindingHash: string
  readonly operationBindingHash: string
  readonly sidecarKind: OwnedDockerSidecarKind
  readonly policyHash: string
  readonly resources: readonly OwnedDockerLedgerResourceV4[]
}

interface ExactRecord { readonly [key: string]: unknown }
interface DatabaseHandle {
  readonly db: Database.Database
  readonly path: string
  readonly stat: Stats
  readonly uid: number
}
interface ManagerRow {
  databaseId: string
  installationId: string
  endpointIdentity: OwnedDockerEndpointIdentityV1
  state: 'recovery' | 'active'
  epoch: number
  operationSequence: number
}
interface LedgerInternal {
  readonly handle: DatabaseHandle
  readonly writer: PrivateSqliteLease
  assertState(state: 'recovery' | 'active', epoch: number): void
  enterRecovery(): number
  activateAfterZero(recoveryEpoch: number): number
  bind(
    epoch: number,
    operationSequence: number,
    role: OwnedDockerResourceRole,
    objectId: string,
    boundProjectionHashV1: string,
  ): void
  deleteOperation(state: 'recovery' | 'active', epoch: number, operationSequence: number): void
  beginRecoveryDispatch(epoch: number): () => void
  beginRecoveryActivation(epoch: number): () => void
  beginTrustedDispatch(epoch: number): () => void
  beginActiveCompletion(epoch: number): (completed: boolean) => void
}
interface AttemptedCreatePermitState {
  readonly ledger: OwnedDockerRecoveryLedger
  readonly docker: OwnedDockerAttestedCommandPort
  readonly epoch: number
  readonly operationSequence: number
  readonly role: OwnedDockerResourceRole
  readonly descriptor: OwnedDockerCreateDescriptorV2
  status: 'active' | 'consumed' | 'revoked'
}
interface AttemptedContainerRecoveryPermitState {
  readonly ledger: OwnedDockerRecoveryLedger
  readonly epoch: number
  readonly operationSequence: number
  readonly descriptor: OwnedDockerCreateDescriptorV2
  status: 'active' | 'consumed' | 'outcome-minted' | 'revoked'
}
interface AttemptedContainerRecoveryOutcomeState {
  readonly permit: OwnedDockerAttemptedContainerRecoveryPermitV1
  readonly observed: OwnedDockerObservedResourceV2 | null
  status: 'active' | 'consumed'
}
interface BoundContainerUsePermitState {
  readonly ledger: OwnedDockerRecoveryLedger
  readonly docker: OwnedDockerAttestedCommandPort
  readonly epoch: number
  readonly operationSequence: number
  readonly role: OwnedDockerResourceRole
  readonly descriptor: OwnedDockerBoundUseDescriptorV2
  status: 'active' | 'consumed' | 'revoked'
}
interface RecoveryBoundContainerCleanupPermitState {
  readonly ledger: OwnedDockerRecoveryLedger
  readonly epoch: number
  readonly operationSequence: number
  readonly expected: OwnedDockerObservedResourceV2
  status: 'active' | 'consumed' | 'outcome-minted' | 'revoked'
}
interface RecoveryBoundContainerCleanupOutcomeState {
  readonly permit: OwnedDockerRecoveryBoundContainerCleanupPermitV1
  readonly kind: 'removed' | 'absent'
  status: 'active' | 'consumed'
}
interface RecoveryActivationPermitState {
  readonly ledger: OwnedDockerRecoveryLedger
  readonly docker: OwnedDockerAttestedCommandPort
  readonly epoch: number
  committedResult: OwnedDockerRecoveryResult | null
  status: 'active' | 'consumed' | 'outcome-minted' | 'committed' | 'revoked'
}
interface RecoveryActivationOutcomeState {
  readonly permit: OwnedDockerRecoveryActivationPermitV1
  status: 'active' | 'consumed'
}

const ledgerInternals = new WeakMap<OwnedDockerRecoveryLedger, LedgerInternal>()
const activeEpochProvenance = new WeakMap<OwnedDockerActiveEpoch, Readonly<{
  ledger: OwnedDockerRecoveryLedger
  docker: OwnedDockerAttestedCommandPort
  epoch: number
}>>()
const operationHandleProvenance = new WeakMap<OwnedDockerOperationHandle, Readonly<{
  activeEpoch: OwnedDockerActiveEpoch
  operationSequence: number
}>>()
const attestedCreateDispatchOutcomes = new WeakSet<object>()
const attemptedCreatePermitStates = new WeakMap<
  OwnedDockerAttemptedCreatePermitV1,
  AttemptedCreatePermitState
>()
const attemptedContainerRecoveryPermitStates = new WeakMap<
  OwnedDockerAttemptedContainerRecoveryPermitV1,
  AttemptedContainerRecoveryPermitState
>()
const attemptedContainerRecoveryOutcomeStates = new WeakMap<
  OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1,
  AttemptedContainerRecoveryOutcomeState
>()
const attemptedContainerRecoveryRowsInFlight = new WeakMap<OwnedDockerRecoveryLedger, Set<string>>()
const boundContainerUsePermitStates = new WeakMap<
  OwnedDockerBoundContainerUsePermitV1,
  BoundContainerUsePermitState
>()
const recoveryBoundContainerCleanupPermitStates = new WeakMap<
  OwnedDockerRecoveryBoundContainerCleanupPermitV1,
  RecoveryBoundContainerCleanupPermitState
>()
const recoveryBoundContainerCleanupOutcomeStates = new WeakMap<
  OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1,
  RecoveryBoundContainerCleanupOutcomeState
>()
const recoveryBoundContainerRowsInFlight = new WeakMap<OwnedDockerRecoveryLedger, Set<string>>()
const recoveryActivationPermitStates = new WeakMap<
  OwnedDockerRecoveryActivationPermitV1,
  RecoveryActivationPermitState
>()
const recoveryActivationOutcomeStates = new WeakMap<
  OwnedDockerAttestedRecoveryActivationOutcomeV1,
  RecoveryActivationOutcomeState
>()

export function isOwnedDockerActiveEpoch(value: unknown): value is OwnedDockerActiveEpoch {
  return typeof value === 'object' && value !== null &&
    activeEpochProvenance.has(value as OwnedDockerActiveEpoch)
}

export function isOwnedDockerOperationHandle(value: unknown): value is OwnedDockerOperationHandle {
  return typeof value === 'object' && value !== null &&
    operationHandleProvenance.has(value as OwnedDockerOperationHandle)
}

export function isOwnedDockerRecoveryLedger(value: unknown): value is OwnedDockerRecoveryLedger {
  return typeof value === 'object' && value !== null && ledgerInternals.has(value as OwnedDockerRecoveryLedger)
}

export function captureOwnedDockerRecoveryAuthorityEpoch(ledger: OwnedDockerRecoveryLedger): number {
  const internal = ledgerInternals.get(ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  ledger.assertOwned()
  const manager = readManager(internal.handle.db)
  if (manager.state !== 'recovery') throw fail('OWNED_DOCKER_RECOVERY_REQUIRED')
  return manager.epoch
}

export function assertOwnedDockerRecoveryAuthority(
  ledger: OwnedDockerRecoveryLedger,
  recoveryEpoch: number,
): void {
  const internal = ledgerInternals.get(ledger)
  if (internal === undefined || !Number.isSafeInteger(recoveryEpoch) || recoveryEpoch < 0) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  internal.assertState('recovery', recoveryEpoch)
}

/**
 * @internal Narrowing transition used by the parent manager after its pinned
 * read-only endpoint preflight. This seam is not an attestation or mutation
 * authority: entering recovery only revokes active use. Every later discovery,
 * cleanup and activation still requires its own genuine one-shot broker and
 * exact endpoint proof.
 */
export function enterOwnedDockerParentRecoveryAfterPinnedProbe(
  ledger: OwnedDockerRecoveryLedger,
  endpointIdentity: unknown,
): number {
  const internal = ledgerInternals.get(ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  const endpoint = validateEndpointIdentity(endpointIdentity)
  if (!endpointEqual(endpoint, ledger.activation.endpointIdentity)) {
    throw fail('OWNED_DOCKER_ENDPOINT_MISMATCH')
  }
  return internal.enterRecovery()
}

export function beginOwnedDockerRecoveryDispatch(
  ledger: OwnedDockerRecoveryLedger,
  recoveryEpoch: number,
): () => void {
  const internal = ledgerInternals.get(ledger)
  if (internal === undefined || !Number.isSafeInteger(recoveryEpoch) || recoveryEpoch < 0) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  return internal.beginRecoveryDispatch(recoveryEpoch)
}

function fail(code: OwnedDockerResourceErrorCode): OwnedDockerResourceError {
  return new OwnedDockerResourceError(code)
}

function nodeErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function exactRecord(value: unknown, keys: readonly string[]): ExactRecord | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length || ownKeys.some(key =>
      typeof key !== 'string' || !keys.includes(key))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return null
    }
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]))
  } catch {
    return null
  }
}

function exactArray(value: unknown, maximum = MAX_SCAN_RESOURCES): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== length + 1 || keys[keys.length - 1] !== 'length') return null
    const result: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return null
      result.push(descriptor.value)
    }
    return result
  } catch {
    return null
  }
}

type HashScalar = string | number | null

function digestFields(domain: string, fields: readonly (readonly [string, HashScalar])[]): string {
  const hash = createHash('sha256')
  const write = (value: string): void => {
    hash.update(String(Buffer.byteLength(value, 'utf8')))
    hash.update(':')
    hash.update(value)
    hash.update(';')
  }
  write(domain)
  for (const [name, value] of fields) {
    write(name)
    write(value === null ? 'null:' : typeof value === 'number' ? `number:${value}` : `string:${value}`)
  }
  return hash.digest('hex')
}

// Detects accidental valid-value rollback inside the private same-UID trust
// boundary. This is an integrity checksum, not an authentication MAC.
function managerIntegrity(manager: ManagerRow): string {
  return digestFields('aisy-owned-docker-manager-integrity-v4', [
    ['databaseId', manager.databaseId],
    ['installationId', manager.installationId],
    ['endpointIdentityVersion', manager.endpointIdentity.version],
    ['endpointBindingHash', manager.endpointIdentity.endpointBindingHash],
    ['serverId', manager.endpointIdentity.serverId],
    ['serverVersion', manager.endpointIdentity.serverVersion],
    ['apiVersion', manager.endpointIdentity.apiVersion],
    ['state', manager.state],
    ['epoch', manager.epoch],
    ['operationSequence', manager.operationSequence],
  ])
}

function validateEndpointIdentity(
  value: unknown,
  failure: OwnedDockerResourceErrorCode = 'OWNED_DOCKER_INPUT_INVALID',
): OwnedDockerEndpointIdentityV1 {
  const record = exactRecord(value, [
    'version', 'endpointBindingHash', 'serverId', 'serverVersion', 'apiVersion',
  ])
  if (record === null || record['version'] !== 1 ||
    typeof record['endpointBindingHash'] !== 'string' || !HASH.test(record['endpointBindingHash']) ||
    typeof record['serverId'] !== 'string' || !SERVER_ID.test(record['serverId']) ||
    typeof record['serverVersion'] !== 'string' || !SERVER_VERSION.test(record['serverVersion']) ||
    typeof record['apiVersion'] !== 'string' || !API_VERSION.test(record['apiVersion'])) throw fail(failure)
  return Object.freeze({
    version: 1,
    endpointBindingHash: record['endpointBindingHash'],
    serverId: record['serverId'],
    serverVersion: record['serverVersion'],
    apiVersion: record['apiVersion'],
  })
}

function endpointEqual(a: OwnedDockerEndpointIdentityV1, b: OwnedDockerEndpointIdentityV1): boolean {
  return a.version === b.version && a.endpointBindingHash === b.endpointBindingHash &&
    a.serverId === b.serverId && a.serverVersion === b.serverVersion && a.apiVersion === b.apiVersion
}

export function ownedDockerActiveEpochMatchesEndpointIdentity(
  value: unknown,
  endpointIdentity: unknown,
): boolean {
  if (!isOwnedDockerActiveEpoch(value) || utilTypes.isProxy(endpointIdentity)) return false
  try {
    const provenance = activeEpochProvenance.get(value)
    return provenance !== undefined && endpointEqual(
      provenance.ledger.activation.endpointIdentity,
      validateEndpointIdentity(endpointIdentity),
    )
  } catch {
    return false
  }
}

function assertDockerEndpoint(
  docker: OwnedDockerAttestedCommandPort,
  expected: OwnedDockerEndpointIdentityV1,
): void {
  let descriptor: PropertyDescriptor | undefined
  try { descriptor = Object.getOwnPropertyDescriptor(docker, 'endpointIdentity') } catch {
    throw fail('OWNED_DOCKER_ENDPOINT_MISMATCH')
  }
  if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
    throw fail('OWNED_DOCKER_ENDPOINT_MISMATCH')
  }
  const observed = validateEndpointIdentity(descriptor.value, 'OWNED_DOCKER_ENDPOINT_MISMATCH')
  if (!endpointEqual(observed, expected)) throw fail('OWNED_DOCKER_ENDPOINT_MISMATCH')
}

function validSidecarKind(value: unknown): value is OwnedDockerSidecarKind {
  return value === 'restricted-clone' || value === 'whisper' || value === 'lease-bound-docker-bash'
}
function validRole(value: unknown): value is OwnedDockerResourceRole {
  return value === 'worker' || value === 'gateway' || value === 'network'
}
function validResourceKind(value: unknown): value is OwnedDockerResourceKind {
  return value === 'container' || value === 'network'
}
function expectedRoles(kind: OwnedDockerSidecarKind): readonly OwnedDockerResourceRole[] {
  return kind === 'restricted-clone' ? ['worker', 'gateway', 'network'] : ['worker']
}

function validateActivation(value: unknown): OwnedDockerLedgerActivationV4 {
  const legacy = exactRecord(value, ['version', 'kind', 'installationId', 'databaseId'])
  if ((legacy?.['version'] === 1 && legacy['kind'] === 'aisy-owned-docker-ledger-v1') ||
    (legacy?.['version'] === 2 && legacy['kind'] === 'aisy-owned-docker-ledger-v2')) {
    throw fail('OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED')
  }
  const legacyV3 = exactRecord(value, [
    'version', 'kind', 'installationId', 'databaseId', 'endpointIdentity',
  ])
  if (legacyV3?.['version'] === 3 && legacyV3['kind'] === 'aisy-owned-docker-ledger-v3') {
    throw fail('OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED')
  }
  const record = exactRecord(value, [
    'version', 'kind', 'installationId', 'databaseId', 'endpointIdentity',
  ])
  if (record === null || record['version'] !== 4 || record['kind'] !== 'aisy-owned-docker-ledger-v4' ||
    typeof record['installationId'] !== 'string' || !HASH.test(record['installationId']) ||
    typeof record['databaseId'] !== 'string' || !HASH.test(record['databaseId'])) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  return Object.freeze({
    version: 4,
    kind: 'aisy-owned-docker-ledger-v4',
    installationId: record['installationId'],
    databaseId: record['databaseId'],
    endpointIdentity: validateEndpointIdentity(record['endpointIdentity']),
  })
}

function validCreateProjectionContract(
  value: unknown,
): value is OwnedDockerCreateProjectionContractV1 {
  return value === 'container-selected-v2' || value === 'network-full-v1'
}

function validatePrepare(value: unknown): OwnedDockerCoordinatorPrepareInputV2 {
  const record = exactRecord(value, ['version', 'sidecarKind', 'policyHash', 'resources'])
  const resources = record === null ? null : exactArray(record['resources'], 3)
  if (record === null || resources === null || record['version'] !== 2 ||
    !validSidecarKind(record['sidecarKind']) || typeof record['policyHash'] !== 'string' ||
    !HASH.test(record['policyHash'])) throw fail('OWNED_DOCKER_INPUT_INVALID')
  // Clone has no reviewed selected-projection normalizer yet. Keep its bounded
  // schema vocabulary dormant instead of allocating an undiscoverable intent.
  if (record['sidecarKind'] === 'restricted-clone') throw fail('OWNED_DOCKER_INPUT_INVALID')
  const validated = resources.map(value => {
    const item = exactRecord(value, [
      'version', 'role', 'resourceKind', 'createProjectionContract', 'createProjectionHash',
    ])
    if (item === null || item['version'] !== 2 || !validRole(item['role']) ||
      !validResourceKind(item['resourceKind']) ||
      !validCreateProjectionContract(item['createProjectionContract']) ||
      typeof item['createProjectionHash'] !== 'string' || !HASH.test(item['createProjectionHash']) ||
      (item['role'] === 'network') !== (item['resourceKind'] === 'network') ||
      (item['resourceKind'] === 'container') !==
        (item['createProjectionContract'] === 'container-selected-v2')) {
      throw fail('OWNED_DOCKER_INPUT_INVALID')
    }
    return Object.freeze({
      version: 2 as const,
      role: item['role'],
      resourceKind: item['resourceKind'],
      createProjectionContract: item['createProjectionContract'],
      createProjectionHash: item['createProjectionHash'],
    })
  })
  const roles = expectedRoles(record['sidecarKind'])
  if (validated.length !== roles.length || validated.some((item, index) => item.role !== roles[index])) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  return Object.freeze({
    version: 2,
    sidecarKind: record['sidecarKind'],
    policyHash: record['policyHash'],
    resources: Object.freeze(validated),
  })
}

function validateLabels(value: unknown): OwnedDockerLabelsV1 {
  const record = exactRecord(value, [
    'version', 'installationId', 'ownerBindingHash', 'sessionBindingHash',
    'operationBindingHash', 'sidecarKind', 'role', 'policyHash',
  ])
  if (record === null || record['version'] !== '1' ||
    typeof record['installationId'] !== 'string' || !HASH.test(record['installationId']) ||
    typeof record['ownerBindingHash'] !== 'string' || !HASH.test(record['ownerBindingHash']) ||
    typeof record['sessionBindingHash'] !== 'string' || !HASH.test(record['sessionBindingHash']) ||
    typeof record['operationBindingHash'] !== 'string' || !HASH.test(record['operationBindingHash']) ||
    !validSidecarKind(record['sidecarKind']) || !validRole(record['role']) ||
    !expectedRoles(record['sidecarKind']).includes(record['role']) ||
    typeof record['policyHash'] !== 'string' || !HASH.test(record['policyHash'])) {
    throw fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
  }
  return Object.freeze({
    version: '1',
    installationId: record['installationId'],
    ownerBindingHash: record['ownerBindingHash'],
    sessionBindingHash: record['sessionBindingHash'],
    operationBindingHash: record['operationBindingHash'],
    sidecarKind: record['sidecarKind'],
    role: record['role'],
    policyHash: record['policyHash'],
  })
}

function validateObserved(value: unknown): OwnedDockerObservedResourceV2 {
  const record = exactRecord(value, [
    'version', 'objectId', 'resourceKind', 'name', 'labels', 'createProjectionContract',
    'createProjectionHash', 'projectionHashV1', 'networkEndpointCount',
  ])
  if (record === null || record['version'] !== 2 || typeof record['objectId'] !== 'string' ||
    !OBJECT_ID.test(record['objectId']) || !validResourceKind(record['resourceKind']) ||
    typeof record['name'] !== 'string' || !RESOURCE_NAME.test(record['name']) ||
    !validCreateProjectionContract(record['createProjectionContract']) ||
    typeof record['createProjectionHash'] !== 'string' || !HASH.test(record['createProjectionHash']) ||
    typeof record['projectionHashV1'] !== 'string' || !HASH.test(record['projectionHashV1']) ||
    (record['resourceKind'] === 'container') !==
      (record['createProjectionContract'] === 'container-selected-v2') ||
    (record['resourceKind'] === 'container' && record['networkEndpointCount'] !== null) ||
    (record['resourceKind'] === 'network' && (!Number.isSafeInteger(record['networkEndpointCount']) ||
      Number(record['networkEndpointCount']) < 0 || Number(record['networkEndpointCount']) > 4096))) {
    throw fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
  }
  const labels = validateLabels(record['labels'])
  if ((labels.role === 'network') !== (record['resourceKind'] === 'network')) {
    throw fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
  }
  return Object.freeze({
    version: 2,
    objectId: record['objectId'],
    resourceKind: record['resourceKind'],
    name: record['name'],
    labels,
    createProjectionContract: record['createProjectionContract'],
    createProjectionHash: record['createProjectionHash'],
    projectionHashV1: record['projectionHashV1'],
    networkEndpointCount: record['networkEndpointCount'] as number | null,
  })
}

/** @internal Only the pinned Docker transport may mint successful create evidence. */
export function mintOwnedDockerAttestedCreateOutcomeV1(
  observed: OwnedDockerObservedResourceV2,
): OwnedDockerAttestedCreateDispatchOutcomeV1 {
  const outcome = Object.freeze({
    kind: 'attested-created' as const,
    observed: validateObserved(observed),
  })
  attestedCreateDispatchOutcomes.add(outcome)
  return outcome
}

function validateCreateDispatchOutcome(value: unknown): OwnedDockerCreateDispatchOutcomeV1 {
  if (utilTypes.isProxy(value)) throw fail('OWNED_DOCKER_INPUT_INVALID')
  const ambiguous = exactRecord(value, ['kind'])
  if (ambiguous?.['kind'] === 'create-ambiguous') {
    return Object.freeze({ kind: 'create-ambiguous' as const })
  }
  if (typeof value !== 'object' || value === null || !attestedCreateDispatchOutcomes.has(value)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const created = exactRecord(value, ['kind', 'observed'])
  if (created?.['kind'] !== 'attested-created' || utilTypes.isProxy(created?.['observed'])) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const observedInput = created['observed']
  if (typeof observedInput !== 'object' || observedInput === null) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  let labels: unknown
  try {
    const descriptor = Object.getOwnPropertyDescriptor(observedInput, 'labels')
    if (descriptor === undefined || !('value' in descriptor)) {
      throw fail('OWNED_DOCKER_INPUT_INVALID')
    }
    labels = descriptor.value
  } catch (error) {
    if (error instanceof OwnedDockerResourceError) throw error
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  if (utilTypes.isProxy(labels)) throw fail('OWNED_DOCKER_INPUT_INVALID')
  return Object.freeze({
    kind: 'attested-created' as const,
    observed: validateObserved(observedInput),
  })
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
  return Number(uid)
}
function noFollowFlag(): number {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
  return constants.O_NOFOLLOW
}
function sameIdentity(a: Stats, b: Stats): boolean {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
}
function privateRegular(stat: Stats, uid: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.nlink === 1 &&
    (stat.mode & 0o777) === 0o600
}

function canonicalRoot(path: string, create: boolean): string {
  if (!isAbsolute(path)) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
  let requested = resolve(path)
  if (process.platform === 'darwin' && (requested === '/var' || requested.startsWith('/var' + sep))) {
    let canonicalTemporary: string
    try { canonicalTemporary = realpathSync('/var') } catch { throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE') }
    if (canonicalTemporary !== '/private/var') throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    requested = join(canonicalTemporary, relative('/var', requested))
  }
  const parsed = parse(requested)
  let current = parsed.root
  for (const component of requested.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    } catch (error) {
      if (error instanceof OwnedDockerResourceError) throw error
      if (nodeErrorCode(error) !== 'ENOENT') throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
      if (!create) throw fail('OWNED_DOCKER_LEDGER_MISSING')
      try { mkdirSync(current, { mode: 0o700 }) } catch (mkdirError) {
        if (nodeErrorCode(mkdirError) !== 'EEXIST') throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
      }
      const raced = lstatSync(current)
      if (!raced.isDirectory() || raced.isSymbolicLink()) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    }
  }
  const stat = lstatSync(requested)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid() ||
    (stat.mode & 0o777) !== 0o700) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
  return requested
}

function mapLeaseError(error: unknown): OwnedDockerResourceError {
  if (!(error instanceof PrivateSqliteLeaseError)) return fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
  if (error.failure === 'busy') return fail('OWNED_DOCKER_LEDGER_BUSY')
  if (error.failure === 'unsafe') return fail('OWNED_DOCKER_LEDGER_UNSAFE')
  if (error.failure === 'corrupt') return fail('OWNED_DOCKER_LEDGER_CORRUPT')
  return fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
}
function acquireWriter(root: string): PrivateSqliteLease {
  try { return acquirePrivateSqliteLease({ root: join(root, '.writer-lease'), profile: WRITER_PROFILE }) }
  catch (error) { throw mapLeaseError(error) }
}

function validateArtifacts(path: string, uid: number): boolean {
  let rollbackJournalPresent = false
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      const stat = lstatSync(path + suffix)
      if (!privateRegular(stat, uid)) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
      if (suffix !== '-journal') throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
      rollbackJournalPresent = true
    } catch (error) {
      if (error instanceof OwnedDockerResourceError) throw error
      if (nodeErrorCode(error) !== 'ENOENT') throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
    }
  }
  return rollbackJournalPresent
}
function configure(db: Database.Database): void {
  db.pragma('busy_timeout = 0')
  db.pragma('locking_mode = NORMAL')
  db.pragma('synchronous = FULL')
  db.pragma('trusted_schema = OFF')
  db.pragma('foreign_keys = ON')
}
function normalizeSql(sql: string): string { return sql.replace(/\s+/g, ' ').trim() }

function readManager(db: Database.Database): ManagerRow {
  const rows = db.prepare(
    'SELECT schema_version, database_id, installation_id, endpoint_binding_hash, server_id, server_version, api_version, manager_state, manager_epoch, operation_seq, integrity_hash FROM ledger_meta',
  ).all() as Array<{
    schema_version: number
    database_id: string
    installation_id: string
    endpoint_binding_hash: string
    server_id: string
    server_version: string
    api_version: string
    manager_state: string
    manager_epoch: number
    operation_seq: number
    integrity_hash: string
  }>
  const row = rows[0]
  if (rows.length !== 1 || row === undefined || row.schema_version !== 4 ||
    !HASH.test(row.database_id) || !HASH.test(row.installation_id) ||
    (row.manager_state !== 'recovery' && row.manager_state !== 'active') ||
    !Number.isSafeInteger(row.manager_epoch) || row.manager_epoch < 0 ||
    !Number.isSafeInteger(row.operation_seq) || row.operation_seq < 0 ||
    !HASH.test(row.integrity_hash)) {
    throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  }
  const manager: ManagerRow = {
    databaseId: row.database_id,
    installationId: row.installation_id,
    endpointIdentity: validateEndpointIdentity({
      version: 1,
      endpointBindingHash: row.endpoint_binding_hash,
      serverId: row.server_id,
      serverVersion: row.server_version,
      apiVersion: row.api_version,
    }, 'OWNED_DOCKER_LEDGER_CORRUPT'),
    state: row.manager_state,
    epoch: row.manager_epoch,
    operationSequence: row.operation_seq,
  }
  if (row.integrity_hash !== managerIntegrity(manager)) throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  return manager
}

function exactDatabaseObjects(db: Database.Database): void {
  const expected = new Map([
    ['ledger_meta', META_SCHEMA], ['operations', OPERATION_SCHEMA], ['resources', RESOURCE_SCHEMA],
  ])
  const objects = db.prepare(
    "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ type: string; name: string; sql: string | null }>
  if (objects.length !== expected.size || objects.some(object => object.type !== 'table' ||
    object.sql === null || normalizeSql(object.sql) !== normalizeSql(expected.get(object.name) ?? ''))) {
    throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  }
}

function validateDatabase(handle: DatabaseHandle): ManagerRow {
  configure(handle.db)
  const userVersion = Number(handle.db.pragma('user_version', { simple: true }))
  if (userVersion === 1 || userVersion === 2 || userVersion === 3) {
    throw fail('OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED')
  }
  if (String(handle.db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'delete' ||
    Number(handle.db.pragma('application_id', { simple: true })) !== APPLICATION_ID ||
    userVersion !== 4 || Number(handle.db.pragma('synchronous', { simple: true })) !== 2 ||
    Number(handle.db.pragma('trusted_schema', { simple: true })) !== 0 ||
    Number(handle.db.pragma('foreign_keys', { simple: true })) !== 1 ||
    String(handle.db.pragma('quick_check', { simple: true })) !== 'ok') {
    throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  }
  exactDatabaseObjects(handle.db)
  validateArtifacts(handle.path, handle.uid)
  return readManager(handle.db)
}

function openExistingDatabase(root: string, readonly = false): DatabaseHandle {
  const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
  const uid = currentUid()
  let before: Stats
  try { before = lstatSync(path) } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') throw fail('OWNED_DOCKER_LEDGER_MISSING')
    throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
  }
  if (!privateRegular(before, uid)) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
  validateArtifacts(path, uid)
  let db: Database.Database
  try { db = new Database(path, { timeout: 0, fileMustExist: true, readonly }) }
  catch { throw fail('OWNED_DOCKER_LEDGER_CORRUPT') }
  try {
    const after = lstatSync(path)
    if (!privateRegular(after, uid) || !sameIdentity(before, after)) {
      throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    }
    return { db, path, stat: after, uid }
  } catch (error) {
    db.close()
    throw error
  }
}

function preflightExistingDatabase(root: string): {
  readonly stat: Stats
  readonly manager: ManagerRow
  readonly recoveryRequired: boolean
} {
  const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
  const uid = currentUid()
  let before: Stats
  try { before = lstatSync(path) } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') throw fail('OWNED_DOCKER_LEDGER_MISSING')
    throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
  }
  if (!privateRegular(before, uid)) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
  let fd: number | null = null
  const header = Buffer.alloc(100)
  try {
    fd = openSync(path, constants.O_RDONLY | noFollowFlag())
    const opened = fstatSync(fd)
    if (!privateRegular(opened, uid) || !sameIdentity(before, opened)) {
      throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    }
    if (readSync(fd, header, 0, 100, 0) !== 100) throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  } catch (error) {
    if (error instanceof OwnedDockerResourceError) throw error
    throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  } finally {
    if (fd !== null) closeSync(fd)
  }
  if (header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
    throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  }
  const userVersion = header.readUInt32BE(60)
  if (header.readUInt32BE(68) !== APPLICATION_ID || header[18] !== 1 || header[19] !== 1) {
    throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  }
  if (userVersion === 1 || userVersion === 2 || userVersion === 3) {
    throw fail('OWNED_DOCKER_LEDGER_SCHEMA_UNSUPPORTED')
  }
  if (userVersion !== 4) throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  const recoveryRequired = validateArtifacts(path, uid)
  const journalBefore = recoveryRequired ? lstatSync(path + '-journal') : null

  const handle = openExistingDatabase(root, true)
  try {
    handle.db.pragma('query_only = ON')
    handle.db.pragma('trusted_schema = OFF')
    if (String(handle.db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'delete' ||
      Number(handle.db.pragma('application_id', { simple: true })) !== APPLICATION_ID ||
      Number(handle.db.pragma('user_version', { simple: true })) !== 4 ||
      String(handle.db.pragma('quick_check', { simple: true })) !== 'ok') {
      throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
    }
    exactDatabaseObjects(handle.db)
    const manager = readManager(handle.db)
    handle.db.close()
    const after = lstatSync(path)
    const journalStillPresent = validateArtifacts(path, uid)
    if (!privateRegular(after, uid) || !sameIdentity(before, after) ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    }
    if (journalStillPresent !== recoveryRequired) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    if (journalBefore !== null) {
      const journalAfter = lstatSync(path + '-journal')
      if (!privateRegular(journalAfter, uid) || !sameIdentity(journalBefore, journalAfter) ||
        journalAfter.size !== journalBefore.size || journalAfter.mtimeMs !== journalBefore.mtimeMs ||
        journalAfter.ctimeMs !== journalBefore.ctimeMs) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    }
    return { stat: after, manager, recoveryRequired }
  } catch (error) {
    if (handle.db.open) handle.db.close()
    throw error instanceof OwnedDockerResourceError ? error : fail('OWNED_DOCKER_LEDGER_CORRUPT')
  }
}

function createDatabase(
  root: string,
  installationId: string,
  endpointIdentity: OwnedDockerEndpointIdentityV1,
): DatabaseHandle {
  const path = join(root, OWNED_DOCKER_LEDGER_FILENAME)
  const uid = currentUid()
  let fd: number | null = null
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
    if (!privateRegular(fstatSync(fd), uid)) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    closeSync(fd)
    fd = null
    const directoryFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlag())
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  } catch (error) {
    if (fd !== null) try { closeSync(fd) } catch { /* preserve the first error */ }
    if (error instanceof OwnedDockerResourceError) throw error
    if (nodeErrorCode(error) === 'EEXIST') {
      const preflight = preflightExistingDatabase(root)
      if (preflight.manager.installationId !== installationId ||
        !endpointEqual(preflight.manager.endpointIdentity, endpointIdentity)) {
        throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
      }
      const existing = openExistingDatabase(root)
      if (!sameIdentity(preflight.stat, existing.stat)) {
        existing.db.close()
        throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
      }
      return existing
    }
    throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
  }
  const handle = openExistingDatabase(root)
  try {
    configure(handle.db)
    handle.db.pragma('journal_mode = DELETE')
    handle.db.pragma('application_id = ' + APPLICATION_ID)
    handle.db.pragma('user_version = 4')
    const transaction = handle.db.transaction(() => {
      handle.db.exec(META_SCHEMA)
      handle.db.exec(OPERATION_SCHEMA)
      handle.db.exec(RESOURCE_SCHEMA)
      const manager: ManagerRow = {
        databaseId: randomBytes(32).toString('hex'),
        installationId,
        endpointIdentity,
        state: 'recovery',
        epoch: 0,
        operationSequence: 0,
      }
      handle.db.prepare(
        "INSERT INTO ledger_meta VALUES (1, 4, ?, ?, ?, ?, ?, ?, 'recovery', 0, 0, ?)",
      ).run(manager.databaseId, installationId, endpointIdentity.endpointBindingHash,
        endpointIdentity.serverId, endpointIdentity.serverVersion, endpointIdentity.apiVersion,
        managerIntegrity(manager))
    })
    transaction.immediate()
    validateDatabase(handle)
    return handle
  } catch (error) {
    handle.db.close()
    throw error instanceof OwnedDockerResourceError ? error : fail('OWNED_DOCKER_LEDGER_CORRUPT')
  }
}

function assertHandle(handle: DatabaseHandle, writer: PrivateSqliteLease): void {
  try { writer.assertHeld() } catch (error) { throw mapLeaseError(error) }
  if (!handle.db.open) throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
  let current: Stats
  try { current = lstatSync(handle.path) } catch { throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE') }
  if (!privateRegular(current, handle.uid) || !sameIdentity(handle.stat, current)) {
    throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
  }
}

function operationBinding(manager: ManagerRow, epoch: number, sequence: number): string {
  return digestFields('aisy-owned-docker-operation-binding-v4', [
    ['databaseId', manager.databaseId],
    ['installationId', manager.installationId],
    ['endpointIdentityVersion', manager.endpointIdentity.version],
    ['endpointBindingHash', manager.endpointIdentity.endpointBindingHash],
    ['serverId', manager.endpointIdentity.serverId],
    ['serverVersion', manager.endpointIdentity.serverVersion],
    ['apiVersion', manager.endpointIdentity.apiVersion],
    ['managerEpoch', epoch],
    ['operationSequence', sequence],
  ])
}
function ownerBinding(manager: ManagerRow): string {
  return digestFields('aisy-owned-docker-owner-binding-v4', [
    ['databaseId', manager.databaseId],
    ['endpointIdentityVersion', manager.endpointIdentity.version],
    ['endpointBindingHash', manager.endpointIdentity.endpointBindingHash],
    ['serverId', manager.endpointIdentity.serverId],
    ['serverVersion', manager.endpointIdentity.serverVersion],
    ['apiVersion', manager.endpointIdentity.apiVersion],
    ['owner', 'installation'],
  ])
}
function sessionBinding(manager: ManagerRow, epoch: number): string {
  return digestFields('aisy-owned-docker-session-binding-v4', [
    ['databaseId', manager.databaseId],
    ['endpointIdentityVersion', manager.endpointIdentity.version],
    ['endpointBindingHash', manager.endpointIdentity.endpointBindingHash],
    ['serverId', manager.endpointIdentity.serverId],
    ['serverVersion', manager.endpointIdentity.serverVersion],
    ['apiVersion', manager.endpointIdentity.apiVersion],
    ['managerEpoch', epoch],
  ])
}
function resourceName(operationHash: string, kind: OwnedDockerSidecarKind, role: OwnedDockerResourceRole): string {
  const shortKind = kind === 'restricted-clone' ? 'clone' :
    kind === 'lease-bound-docker-bash' ? 'bash' : 'whisper'
  const suffix = digestFields('aisy-owned-docker-resource-name-v4', [
    ['operationBindingHash', operationHash], ['role', role],
  ]).slice(0, 24)
  return `aisy-${shortKind}-${role}-${suffix}`
}
function operationIntegrity(operation: Omit<OwnedDockerLedgerOperationV4, 'resources'>): string {
  return digestFields('aisy-owned-docker-operation-integrity-v4', [
    ['operationSequence', operation.operationSequence],
    ['managerEpoch', operation.managerEpoch],
    ['installationId', operation.installationId],
    ['ownerBindingHash', operation.ownerBindingHash],
    ['sessionBindingHash', operation.sessionBindingHash],
    ['operationBindingHash', operation.operationBindingHash],
    ['sidecarKind', operation.sidecarKind],
    ['policyHash', operation.policyHash],
  ])
}
function resourceIntegrity(input: {
  operationSequence: number
  role: OwnedDockerResourceRole
  resourceKind: OwnedDockerResourceKind
  name: string
  createProjectionContract: OwnedDockerCreateProjectionContractV1
  createProjectionHash: string
  boundProjectionHashV1: string | null
  phase: OwnedDockerLedgerResourceV4['phase']
}): string {
  return digestFields('aisy-owned-docker-resource-integrity-v4', [
    ['operationSequence', input.operationSequence],
    ['role', input.role],
    ['resourceKind', input.resourceKind],
    ['name', input.name],
    ['createProjectionContract', input.createProjectionContract],
    ['createProjectionHash', input.createProjectionHash],
    ['boundProjectionHashV1', input.boundProjectionHashV1],
    ['phase', input.phase],
  ])
}
function objectIntegrity(input: {
  operationSequence: number
  role: OwnedDockerResourceRole
  objectId: string
  boundProjectionHashV1: string
}): string {
  return digestFields('aisy-owned-docker-object-integrity-v4', [
    ['operationSequence', input.operationSequence],
    ['role', input.role],
    ['objectId', input.objectId],
    ['boundProjectionHashV1', input.boundProjectionHashV1],
  ])
}

function listOperations(ledger: OwnedDockerRecoveryLedger): readonly OwnedDockerLedgerOperationV4[] {
  const internal = ledgerInternals.get(ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  ledger.assertOwned()
  const manager = readManager(internal.handle.db)
  const operations = internal.handle.db.prepare(
    'SELECT operation_seq, operation_binding_hash, manager_epoch, owner_binding_hash, session_binding_hash, sidecar_kind, policy_hash, integrity_hash FROM operations ORDER BY operation_seq',
  ).all() as Array<Record<string, unknown>>
  const resources = internal.handle.db.prepare(
    "SELECT operation_seq, role, resource_kind, resource_name, create_projection_contract, create_projection_hash, bound_projection_hash_v1, phase, integrity_hash, object_id, object_integrity_hash FROM resources ORDER BY operation_seq, CASE role WHEN 'worker' THEN 1 WHEN 'gateway' THEN 2 ELSE 3 END",
  ).all() as Array<Record<string, unknown>>
  const result: OwnedDockerLedgerOperationV4[] = []
  for (const row of operations) {
    const sequence = Number(row['operation_seq'])
    const operationResources = resources.filter(resource => Number(resource['operation_seq']) === sequence)
    if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > manager.operationSequence ||
      typeof row['operation_binding_hash'] !== 'string' ||
      row['operation_binding_hash'] !== operationBinding(manager, Number(row['manager_epoch']), sequence) ||
      !Number.isSafeInteger(row['manager_epoch']) || Number(row['manager_epoch']) <= 0 ||
      typeof row['owner_binding_hash'] !== 'string' || row['owner_binding_hash'] !== ownerBinding(manager) ||
      typeof row['session_binding_hash'] !== 'string' ||
      row['session_binding_hash'] !== sessionBinding(manager, Number(row['manager_epoch'])) ||
      !validSidecarKind(row['sidecar_kind']) || typeof row['policy_hash'] !== 'string' ||
      !HASH.test(row['policy_hash'])) throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
    const base = {
      version: 4 as const,
      operationSequence: sequence,
      managerEpoch: Number(row['manager_epoch']),
      installationId: manager.installationId,
      ownerBindingHash: row['owner_binding_hash'],
      sessionBindingHash: row['session_binding_hash'],
      operationBindingHash: row['operation_binding_hash'],
      sidecarKind: row['sidecar_kind'],
      policyHash: row['policy_hash'],
    }
    if (row['integrity_hash'] !== operationIntegrity(base)) throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
    const roles = expectedRoles(base.sidecarKind)
    if (operationResources.length !== roles.length) throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
    const items = operationResources.map((resource, index): OwnedDockerLedgerResourceV4 => {
      const role = resource['role']
      const kind = resource['resource_kind']
      const phase = resource['phase']
      const name = resource['resource_name']
      const createProjectionContract = resource['create_projection_contract']
      const createProjectionHash = resource['create_projection_hash']
      const boundProjectionHashV1 = resource['bound_projection_hash_v1']
      const objectId = resource['object_id']
      if (!validRole(role) || role !== roles[index] || !validResourceKind(kind) ||
        (role === 'network') !== (kind === 'network') ||
        typeof name !== 'string' || name !== resourceName(base.operationBindingHash, base.sidecarKind, role) ||
        !validCreateProjectionContract(createProjectionContract) ||
        (kind === 'container') !== (createProjectionContract === 'container-selected-v2') ||
        typeof createProjectionHash !== 'string' || !HASH.test(createProjectionHash) ||
        (boundProjectionHashV1 !== null &&
          (typeof boundProjectionHashV1 !== 'string' || !HASH.test(boundProjectionHashV1))) ||
        (phase !== 'prepared' && phase !== 'attempted' && phase !== 'bound') ||
        resource['integrity_hash'] !== resourceIntegrity({
          operationSequence: sequence, role, resourceKind: kind, name, createProjectionContract,
          createProjectionHash, boundProjectionHashV1: boundProjectionHashV1 as string | null, phase,
        })) throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
      if (phase === 'bound') {
        if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId) ||
          typeof boundProjectionHashV1 !== 'string' || !HASH.test(boundProjectionHashV1) ||
          resource['object_integrity_hash'] !== objectIntegrity({
            operationSequence: sequence, role, objectId, boundProjectionHashV1,
          })) throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
      } else if (boundProjectionHashV1 !== null || objectId !== null ||
        resource['object_integrity_hash'] !== null) {
        throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
      }
      return Object.freeze({
        version: 2, role, resourceKind: kind, name, createProjectionContract, createProjectionHash,
        boundProjectionHashV1: boundProjectionHashV1 as string | null, phase, objectId,
      })
    })
    result.push(Object.freeze({ ...base, resources: Object.freeze(items) }))
  }
  if (resources.some(resource => !operations.some(operation =>
    Number(operation['operation_seq']) === Number(resource['operation_seq'])))) {
    throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  }
  return Object.freeze(result)
}

function makeLedger(
  handle: DatabaseHandle,
  writer: PrivateSqliteLease,
  activation: OwnedDockerLedgerActivationV4,
): OwnedDockerRecoveryLedger {
  let closed = false
  let recoveryDispatches = 0
  let recoveryActivations = 0
  let trustedDispatches = 0
  let activeCompletions = 0
  const assertOwned = (): void => {
    if (closed) throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
    assertHandle(handle, writer)
  }
  const assertState = (state: 'recovery' | 'active', epoch: number): void => {
    assertOwned()
    const manager = readManager(handle.db)
    if (manager.state !== state || manager.epoch !== epoch) {
      throw fail(state === 'active' ? 'OWNED_DOCKER_EPOCH_STALE' : 'OWNED_DOCKER_RECOVERY_REQUIRED')
    }
  }
  const enterRecovery = (): number => {
    assertOwned()
    if (recoveryDispatches !== 0 || recoveryActivations !== 0 ||
      trustedDispatches !== 0 || activeCompletions !== 0) {
      throw fail('OWNED_DOCKER_LEDGER_BUSY')
    }
    try {
      const transaction = handle.db.transaction(() => {
        if (recoveryDispatches !== 0 || recoveryActivations !== 0 ||
          trustedDispatches !== 0 || activeCompletions !== 0) {
          throw fail('OWNED_DOCKER_LEDGER_BUSY')
        }
        const manager = readManager(handle.db)
        if (manager.state === 'recovery') return manager.epoch
        if (manager.epoch >= MAX_OPERATION_SEQUENCE) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
        const next = manager.epoch + 1
        const nextManager: ManagerRow = { ...manager, state: 'recovery', epoch: next }
        const changed = handle.db.prepare(
          "UPDATE ledger_meta SET manager_state = 'recovery', manager_epoch = ?, integrity_hash = ? WHERE singleton = 1 AND manager_state = 'active' AND manager_epoch = ? AND integrity_hash = ?",
        ).run(next, managerIntegrity(nextManager), manager.epoch, managerIntegrity(manager))
        if (changed.changes !== 1) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
        return next
      })
      return transaction.immediate()
    } catch (error) {
      if (error instanceof OwnedDockerResourceError) throw error
      throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
    }
  }
  const activateAfterZero = (recoveryEpoch: number): number => {
    assertState('recovery', recoveryEpoch)
    if (recoveryDispatches !== 0 || trustedDispatches !== 0 || activeCompletions !== 0 ||
      recoveryActivations !== 1) {
      throw fail('OWNED_DOCKER_LEDGER_BUSY')
    }
    try {
      const transaction = handle.db.transaction(() => {
        if (recoveryDispatches !== 0 || trustedDispatches !== 0 || activeCompletions !== 0 ||
          recoveryActivations !== 1) {
          throw fail('OWNED_DOCKER_LEDGER_BUSY')
        }
        const manager = readManager(handle.db)
        if (manager.state !== 'recovery' || manager.epoch !== recoveryEpoch) {
          throw fail('OWNED_DOCKER_EPOCH_STALE')
        }
        const remaining = Number(handle.db.prepare('SELECT count(*) FROM operations').pluck().get())
        if (remaining !== 0) throw fail('OWNED_DOCKER_RECOVERY_REQUIRED')
        if (recoveryEpoch >= MAX_OPERATION_SEQUENCE) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
        const epoch = recoveryEpoch + 1
        const nextManager: ManagerRow = { ...manager, state: 'active', epoch }
        const changed = handle.db.prepare(
          "UPDATE ledger_meta SET manager_state = 'active', manager_epoch = ?, integrity_hash = ? WHERE singleton = 1 AND manager_state = 'recovery' AND manager_epoch = ? AND integrity_hash = ?",
        ).run(epoch, managerIntegrity(nextManager), recoveryEpoch, managerIntegrity(manager))
        if (changed.changes !== 1) throw fail('OWNED_DOCKER_EPOCH_STALE')
        return epoch
      })
      return transaction.immediate()
    } catch (error) {
      if (error instanceof OwnedDockerResourceError) throw error
      throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
    }
  }
  const bind = (
    epoch: number,
    operationSequence: number,
    role: OwnedDockerResourceRole,
    objectId: string,
    boundProjectionHashV1: string,
  ): void => {
    if (!Number.isSafeInteger(operationSequence) || operationSequence <= 0 || !validRole(role) ||
      !OBJECT_ID.test(objectId) || !HASH.test(boundProjectionHashV1)) {
      throw fail('OWNED_DOCKER_INPUT_INVALID')
    }
    assertState(readManager(handle.db).state, epoch)
    const operation = listOperations(ledger).find(item => item.operationSequence === operationSequence)
    const resource = operation?.resources.find(item => item.role === role)
    if (operation === undefined || resource === undefined || resource.phase === 'prepared' ||
      (resource.objectId !== null && resource.objectId !== objectId) ||
      (resource.boundProjectionHashV1 !== null &&
        resource.boundProjectionHashV1 !== boundProjectionHashV1)) {
      throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    }
    if (resource.objectId === objectId && resource.boundProjectionHashV1 === boundProjectionHashV1) return
    try {
      const changed = handle.db.prepare(
        "UPDATE resources SET phase = 'bound', bound_projection_hash_v1 = ?, integrity_hash = ?, object_id = ?, object_integrity_hash = ? WHERE operation_seq = ? AND role = ? AND phase = 'attempted' AND bound_projection_hash_v1 IS NULL AND object_id IS NULL AND object_integrity_hash IS NULL",
      ).run(boundProjectionHashV1,
        resourceIntegrity({
          operationSequence,
          role: resource.role,
          resourceKind: resource.resourceKind,
          name: resource.name,
          createProjectionContract: resource.createProjectionContract,
          createProjectionHash: resource.createProjectionHash,
          boundProjectionHashV1,
          phase: 'bound',
        }),
        objectId, objectIntegrity({ operationSequence, role, objectId, boundProjectionHashV1 }),
        operationSequence, role)
      if (changed.changes !== 1) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    } catch (error) {
      if (error instanceof OwnedDockerResourceError) throw error
      throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
    }
    assertState(readManager(handle.db).state, epoch)
  }
  const deleteOperation = (
    state: 'recovery' | 'active', epoch: number, operationSequence: number,
  ): void => {
    assertState(state, epoch)
    try {
      const changed = handle.db.prepare('DELETE FROM operations WHERE operation_seq = ?').run(operationSequence)
      if (changed.changes !== 1) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    } catch (error) {
      if (error instanceof OwnedDockerResourceError) throw error
      throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
    }
    assertState(state, epoch)
  }
  const beginTrustedDispatch = (epoch: number): (() => void) => {
    assertState('active', epoch)
    if (recoveryActivations !== 0) throw fail('OWNED_DOCKER_LEDGER_BUSY')
    trustedDispatches += 1
    let released = false
    return () => {
      if (released) return
      released = true
      trustedDispatches -= 1
    }
  }
  const beginRecoveryDispatch = (epoch: number): (() => void) => {
    assertState('recovery', epoch)
    if (recoveryActivations !== 0) throw fail('OWNED_DOCKER_LEDGER_BUSY')
    recoveryDispatches += 1
    let released = false
    return () => {
      if (released) return
      released = true
      recoveryDispatches -= 1
    }
  }
  const beginRecoveryActivation = (epoch: number): (() => void) => {
    assertState('recovery', epoch)
    if (recoveryDispatches !== 0 || recoveryActivations !== 0 ||
      trustedDispatches !== 0 || activeCompletions !== 0) {
      throw fail('OWNED_DOCKER_LEDGER_BUSY')
    }
    recoveryActivations = 1
    let released = false
    return () => {
      if (released) return
      released = true
      recoveryActivations = 0
    }
  }
  const beginActiveCompletion = (epoch: number): ((completed: boolean) => void) => {
    assertState('active', epoch)
    activeCompletions += 1
    let released = false
    return (_completed: boolean) => {
      if (released) return
      released = true
      activeCompletions -= 1
    }
  }
  const ledger: OwnedDockerRecoveryLedger = Object.freeze({
    activation,
    mode: 'recovery' as const,
    listOperations() { return listOperations(ledger) },
    recoverPreparedOperation(operationBindingHash: string) {
      return recoverPreparedOperation(ledger, operationBindingHash)
    },
    recoverAttemptedContainer(
      operationBindingHash: string,
      dispatch: (
        descriptor: OwnedDockerCreateDescriptorV2,
        permit: OwnedDockerAttemptedContainerRecoveryPermitV1,
      ) => Promise<OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1>,
    ) {
      return recoverAttemptedContainer(ledger, operationBindingHash, dispatch)
    },
    recoverBoundContainer(
      operationBindingHash: string,
      dispatch: (
        expected: OwnedDockerObservedResourceV2,
        permit: OwnedDockerRecoveryBoundContainerCleanupPermitV1,
      ) => Promise<OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1>,
    ) {
      return recoverBoundContainer(ledger, operationBindingHash, dispatch)
    },
    activateAfterInstallationZero(
      docker: OwnedDockerAttestedCommandPort,
      broker: unknown,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) {
      return activateAfterInstallationZero(ledger, docker, broker, options)
    },
    assertOwned,
    close() {
      if (closed) return
      if (recoveryDispatches !== 0 || recoveryActivations !== 0 ||
        trustedDispatches !== 0 || activeCompletions !== 0) {
        throw fail('OWNED_DOCKER_LEDGER_BUSY')
      }
      closed = true
      try { handle.db.close() } finally { writer.release() }
    },
  })
  ledgerInternals.set(ledger, {
    handle, writer, assertState, enterRecovery, activateAfterZero, bind, deleteOperation,
    beginRecoveryDispatch, beginRecoveryActivation, beginTrustedDispatch, beginActiveCompletion,
  })
  return ledger
}

/** Offline bootstrap. v1-v3 databases are deliberately never migrated live. */
export function initializeOwnedDockerResourceLedger(input: Readonly<{
  root: string
  installationId: string
  endpointIdentity: OwnedDockerEndpointIdentityV1
}>): OwnedDockerLedgerActivationV4 {
  const record = exactRecord(input, ['root', 'installationId', 'endpointIdentity'])
  if (record === null || typeof record['root'] !== 'string' || record['root'].length === 0 ||
    typeof record['installationId'] !== 'string' || !HASH.test(record['installationId'])) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const endpointIdentity = validateEndpointIdentity(record['endpointIdentity'])
  const root = canonicalRoot(record['root'], true)
  // Existing ledgers are raw-preflighted before the writer lease is acquired.
  // In particular, refusing v1-v3 must not create or alter lease artifacts.
  try {
    lstatSync(join(root, OWNED_DOCKER_LEDGER_FILENAME))
    preflightExistingDatabase(root)
  } catch (error) {
    if (error instanceof OwnedDockerResourceError) throw error
    if (nodeErrorCode(error) !== 'ENOENT') throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
  }
  const writer = acquireWriter(root)
  let handle: DatabaseHandle | null = null
  try {
    handle = createDatabase(root, record['installationId'], endpointIdentity)
    const manager = validateDatabase(handle)
    if (manager.installationId !== record['installationId'] ||
      !endpointEqual(manager.endpointIdentity, endpointIdentity)) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    return Object.freeze({
      version: 4,
      kind: 'aisy-owned-docker-ledger-v4',
      installationId: manager.installationId,
      databaseId: manager.databaseId,
      endpointIdentity: manager.endpointIdentity,
    })
  } finally {
    if (handle !== null) handle.db.close()
    writer.release()
  }
}

/** Read-only production activation load. Missing state is never bootstrapped here. */
export function loadOwnedDockerResourceLedgerActivation(input: Readonly<{
  root: string
  installationId: string
  endpointIdentity: OwnedDockerEndpointIdentityV1
}>): OwnedDockerLedgerActivationV4 {
  const record = exactRecord(input, ['root', 'installationId', 'endpointIdentity'])
  if (record === null || typeof record['root'] !== 'string' || record['root'].length === 0 ||
    typeof record['installationId'] !== 'string' || !HASH.test(record['installationId'])) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const endpointIdentity = validateEndpointIdentity(record['endpointIdentity'])
  const root = canonicalRoot(record['root'], false)
  const preflight = preflightExistingDatabase(root)
  if (preflight.manager.installationId !== record['installationId'] ||
    !endpointEqual(preflight.manager.endpointIdentity, endpointIdentity)) {
    throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  }
  return Object.freeze({
    version: 4,
    kind: 'aisy-owned-docker-ledger-v4',
    installationId: preflight.manager.installationId,
    databaseId: preflight.manager.databaseId,
    endpointIdentity: preflight.manager.endpointIdentity,
  })
}

/** Runtime open is recovery-only and never creates missing artifacts. */
export function openActivatedOwnedDockerResourceLedger(input: Readonly<{
  root: string
  activation:
    | OwnedDockerLedgerActivationV4
    | OwnedDockerLedgerActivationV3
    | OwnedDockerLedgerActivationV2
    | OwnedDockerLedgerActivationV1
}>): OwnedDockerRecoveryLedger {
  const record = exactRecord(input, ['root', 'activation'])
  if (record === null || typeof record['root'] !== 'string' || record['root'].length === 0) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const activation = validateActivation(record['activation'])
  const root = canonicalRoot(record['root'], false)
  const preflight = preflightExistingDatabase(root)
  if (preflight.manager.databaseId !== activation.databaseId ||
    preflight.manager.installationId !== activation.installationId ||
    !endpointEqual(preflight.manager.endpointIdentity, activation.endpointIdentity)) {
    throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
  }
  try {
    const leaseRoot = join(root, '.writer-lease')
    const stat = lstatSync(leaseRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid() ||
      (stat.mode & 0o777) !== 0o700) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    for (const filename of [WRITER_PROFILE.filename, WRITER_PROFILE.filename + '.identity.json']) {
      if (!privateRegular(lstatSync(join(leaseRoot, filename)), currentUid())) {
        throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
      }
    }
  } catch (error) {
    if (error instanceof OwnedDockerResourceError) throw error
    if (nodeErrorCode(error) === 'ENOENT') throw fail('OWNED_DOCKER_LEDGER_MISSING')
    throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
  }
  let writer: PrivateSqliteLease
  try { writer = acquireWriter(root) } catch (error) {
    if (error instanceof OwnedDockerResourceError && error.code === 'OWNED_DOCKER_LEDGER_UNAVAILABLE') {
      throw fail('OWNED_DOCKER_LEDGER_MISSING')
    }
    throw error
  }
  let handle: DatabaseHandle | null = null
  try {
    handle = openExistingDatabase(root)
    if (!sameIdentity(preflight.stat, handle.stat)) throw fail('OWNED_DOCKER_LEDGER_UNSAFE')
    const manager = validateDatabase(handle)
    if (manager.databaseId !== activation.databaseId ||
      manager.installationId !== activation.installationId ||
      !endpointEqual(manager.endpointIdentity, activation.endpointIdentity)) {
      throw fail('OWNED_DOCKER_LEDGER_CORRUPT')
    }
    return makeLedger(handle, writer, activation)
  } catch (error) {
    if (handle !== null) handle.db.close()
    writer.release()
    throw error instanceof OwnedDockerResourceError ? error : fail('OWNED_DOCKER_LEDGER_CORRUPT')
  }
}

function labelsFor(operation: OwnedDockerLedgerOperationV4, role: OwnedDockerResourceRole): OwnedDockerLabelsV1 {
  return Object.freeze({
    version: '1', installationId: operation.installationId,
    ownerBindingHash: operation.ownerBindingHash, sessionBindingHash: operation.sessionBindingHash,
    operationBindingHash: operation.operationBindingHash, sidecarKind: operation.sidecarKind,
    role, policyHash: operation.policyHash,
  })
}
function labelsEqual(a: OwnedDockerLabelsV1, b: OwnedDockerLabelsV1): boolean {
  return a.version === b.version && a.installationId === b.installationId &&
    a.ownerBindingHash === b.ownerBindingHash && a.sessionBindingHash === b.sessionBindingHash &&
    a.operationBindingHash === b.operationBindingHash && a.sidecarKind === b.sidecarKind &&
    a.role === b.role && a.policyHash === b.policyHash
}
function observedEqual(a: OwnedDockerObservedResourceV2, b: OwnedDockerObservedResourceV2): boolean {
  return a.version === b.version && a.objectId === b.objectId && a.resourceKind === b.resourceKind &&
    a.name === b.name && a.createProjectionContract === b.createProjectionContract &&
    a.createProjectionHash === b.createProjectionHash && a.projectionHashV1 === b.projectionHashV1 &&
    a.networkEndpointCount === b.networkEndpointCount && labelsEqual(a.labels, b.labels)
}
function resourceKey(operationBindingHash: string, role: OwnedDockerResourceRole): string {
  return operationBindingHash + '\0' + role
}
function assertObserved(
  observed: OwnedDockerObservedResourceV2,
  operation: OwnedDockerLedgerOperationV4,
  resource: OwnedDockerLedgerResourceV4,
): void {
  if (observed.resourceKind !== resource.resourceKind || observed.name !== resource.name ||
    observed.createProjectionContract !== resource.createProjectionContract ||
    observed.createProjectionHash !== resource.createProjectionHash ||
    (resource.createProjectionContract === 'network-full-v1' &&
      observed.projectionHashV1 !== resource.createProjectionHash) ||
    !labelsEqual(observed.labels, labelsFor(operation, resource.role)) ||
    (resource.objectId !== null && observed.objectId !== resource.objectId) ||
    (resource.boundProjectionHashV1 !== null &&
      observed.projectionHashV1 !== resource.boundProjectionHashV1)) {
    throw fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
  }
}

async function portCall<T>(
  ledger: OwnedDockerRecoveryLedger,
  docker: OwnedDockerAttestedCommandPort,
  call: () => Promise<T>,
): Promise<T> {
  assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
  let result: T
  try {
    result = await call()
  } catch {
    // Endpoint replacement dominates a generic daemon failure.
    assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
    throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
  }
  assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
  return result
}
function validateProbe(value: unknown): OwnedDockerProbeResult {
  const record = exactRecord(value, ['kind'])
  if (record === null || (record['kind'] !== 'compatible' && record['kind'] !== 'incompatible' &&
    record['kind'] !== 'ambiguous')) throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
  return { kind: record['kind'] }
}
function validateScan(value: unknown): OwnedDockerScanResult {
  const ambiguous = exactRecord(value, ['kind'])
  if (ambiguous?.['kind'] === 'ambiguous') return { kind: 'ambiguous' }
  const record = exactRecord(value, ['kind', 'resources'])
  const resources = record === null ? null : exactArray(record['resources'])
  if (record === null || record['kind'] !== 'ok' || resources === null) {
    throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
  }
  return { kind: 'ok', resources: Object.freeze(resources.map(validateObserved)) }
}
function validateInspect(value: unknown): OwnedDockerInspectResult {
  const simple = exactRecord(value, ['kind'])
  if (simple !== null && (simple['kind'] === 'absent' || simple['kind'] === 'ambiguous')) {
    return { kind: simple['kind'] }
  }
  const record = exactRecord(value, ['kind', 'resource'])
  if (record === null || record['kind'] !== 'found') throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
  return { kind: 'found', resource: validateObserved(record['resource']) }
}
function validateRemove(value: unknown): OwnedDockerRemoveResult {
  const record = exactRecord(value, ['kind'])
  if (record === null || (record['kind'] !== 'removed' && record['kind'] !== 'absent' &&
    record['kind'] !== 'ambiguous')) throw fail('OWNED_DOCKER_REMOVAL_AMBIGUOUS')
  return { kind: record['kind'] }
}

async function scanAndValidate(
  ledger: OwnedDockerRecoveryLedger,
  docker: OwnedDockerAttestedCommandPort,
  operations: readonly OwnedDockerLedgerOperationV4[],
): Promise<Map<string, OwnedDockerObservedResourceV2>> {
  const scan = validateScan(await portCall(ledger, docker,
    () => docker.scanInstallation(ledger.activation.installationId)))
  if (scan.kind !== 'ok') throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
  const expected = new Map<string, {
    operation: OwnedDockerLedgerOperationV4
    resource: OwnedDockerLedgerResourceV4
  }>()
  for (const operation of operations) for (const resource of operation.resources) {
    expected.set(resourceKey(operation.operationBindingHash, resource.role), { operation, resource })
  }
  const found = new Map<string, OwnedDockerObservedResourceV2>()
  const ids = new Set<string>()
  for (const observed of scan.resources) {
    const key = resourceKey(observed.labels.operationBindingHash, observed.labels.role)
    const item = expected.get(key)
    if (observed.labels.installationId !== ledger.activation.installationId || item === undefined ||
      ids.has(observed.objectId) || found.has(key)) throw fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
    ids.add(observed.objectId)
    assertObserved(observed, item.operation, item.resource)
    if (item.resource.phase === 'prepared') throw fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
    found.set(key, observed)
  }
  return found
}

async function reconcileScope(input: {
  ledger: OwnedDockerRecoveryLedger
  docker: OwnedDockerAttestedCommandPort
  state: 'recovery' | 'active'
  epoch: number
  operationSequence: number | null
}): Promise<OwnedDockerScopedCompletionResult> {
  const internal = ledgerInternals.get(input.ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  internal.assertState(input.state, input.epoch)
  const all = input.ledger.listOperations()
  const probe = validateProbe(await portCall(input.ledger, input.docker, () => input.docker.probe()))
  if (probe.kind === 'ambiguous') throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
  if (probe.kind === 'incompatible') throw fail('OWNED_DOCKER_DAEMON_INCOMPATIBLE')
  const targets = input.operationSequence === null
    ? all
    : all.filter(operation => operation.operationSequence === input.operationSequence)
  if (input.operationSequence !== null && targets.length !== 1) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  const targetSequences = new Set(targets.map(operation => operation.operationSequence))
  const found = await scanAndValidate(input.ledger, input.docker, all)

  for (const operation of targets) for (const resource of operation.resources) {
    const observed = found.get(resourceKey(operation.operationBindingHash, resource.role))
    if (observed !== undefined && resource.phase === 'attempted') {
      assertDockerEndpoint(input.docker, input.ledger.activation.endpointIdentity)
      internal.assertState(input.state, input.epoch)
      internal.bind(
        input.epoch,
        operation.operationSequence,
        resource.role,
        observed.objectId,
        observed.projectionHashV1,
      )
    }
  }
  const refreshed = input.ledger.listOperations()
  const removal: Array<{
    operation: OwnedDockerLedgerOperationV4
    resource: OwnedDockerLedgerResourceV4
    observed: OwnedDockerObservedResourceV2
  }> = []
  for (const operation of refreshed.filter(item => targetSequences.has(item.operationSequence))) {
    for (const resource of operation.resources) {
      const observed = found.get(resourceKey(operation.operationBindingHash, resource.role))
      if (observed !== undefined) {
        removal.push({ operation, resource, observed })
        continue
      }
      const named = validateInspect(await portCall(input.ledger, input.docker, () => input.docker.inspectByName({
        resourceKind: resource.resourceKind, name: resource.name,
      })))
      if (named.kind === 'ambiguous') throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
      if (named.kind === 'found') {
        assertObserved(named.resource, operation, resource)
        throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
      }
      if (resource.phase === 'attempted') throw fail('OWNED_DOCKER_CREATE_UNRESOLVED')
      if (resource.phase === 'bound' && resource.objectId !== null) {
        const byId = validateInspect(await portCall(input.ledger, input.docker, () => input.docker.inspectById({
          resourceKind: resource.resourceKind, objectId: resource.objectId!,
        })))
        if (byId.kind !== 'absent') throw byId.kind === 'ambiguous'
          ? fail('OWNED_DOCKER_DAEMON_AMBIGUOUS') : fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
      }
    }
  }
  const rank: Record<OwnedDockerResourceRole, number> = { worker: 1, gateway: 2, network: 3 }
  removal.sort((a, b) => rank[a.resource.role] - rank[b.resource.role] ||
    a.operation.operationSequence - b.operation.operationSequence)
  let removedResources = 0
  for (const item of removal) {
    const inspected = validateInspect(await portCall(input.ledger, input.docker, () => input.docker.inspectById({
      resourceKind: item.resource.resourceKind, objectId: item.observed.objectId,
    })))
    if (inspected.kind === 'ambiguous') throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
    if (inspected.kind === 'found') {
      if (!observedEqual(inspected.resource, item.observed)) throw fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
      if (item.resource.resourceKind === 'network' && inspected.resource.networkEndpointCount !== 0) {
        throw fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
      }
      internal.assertState(input.state, input.epoch)
      const removed = validateRemove(await portCall(input.ledger, input.docker, () => input.docker.removeById({
        resourceKind: item.resource.resourceKind, objectId: item.observed.objectId,
      })))
      if (removed.kind === 'ambiguous') throw fail('OWNED_DOCKER_REMOVAL_AMBIGUOUS')
      if (removed.kind === 'removed') removedResources += 1
    }
    const absent = validateInspect(await portCall(input.ledger, input.docker, () => input.docker.inspectById({
      resourceKind: item.resource.resourceKind, objectId: item.observed.objectId,
    })))
    if (absent.kind !== 'absent') throw absent.kind === 'ambiguous'
      ? fail('OWNED_DOCKER_DAEMON_AMBIGUOUS') : fail('OWNED_DOCKER_REMOVAL_AMBIGUOUS')
  }
  internal.assertState(input.state, input.epoch)
  const final = await scanAndValidate(input.ledger, input.docker, input.ledger.listOperations())
  if ([...final.keys()].some(key => {
    const binding = key.slice(0, 64)
    return refreshed.some(operation => targetSequences.has(operation.operationSequence) &&
      operation.operationBindingHash === binding)
  })) throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
  for (const operation of refreshed.filter(item => targetSequences.has(item.operationSequence))) {
    for (const resource of operation.resources) {
      const named = validateInspect(await portCall(input.ledger, input.docker, () => input.docker.inspectByName({
        resourceKind: resource.resourceKind, name: resource.name,
      })))
      if (named.kind !== 'absent') throw named.kind === 'ambiguous'
        ? fail('OWNED_DOCKER_DAEMON_AMBIGUOUS') : fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
    }
    assertDockerEndpoint(input.docker, input.ledger.activation.endpointIdentity)
    internal.assertState(input.state, input.epoch)
    internal.deleteOperation(input.state, input.epoch, operation.operationSequence)
  }
  return Object.freeze({ kind: 'completed', clearedOperations: targets.length, removedResources })
}

function descriptor(
  operation: OwnedDockerLedgerOperationV4,
  resource: OwnedDockerLedgerResourceV4,
): OwnedDockerCreateDescriptorV2 {
  return Object.freeze({
    version: 2,
    operationBindingHash: operation.operationBindingHash,
    role: resource.role,
    resourceKind: resource.resourceKind,
    name: resource.name,
    labels: labelsFor(operation, resource.role),
    createProjectionContract: resource.createProjectionContract,
    createProjectionHash: resource.createProjectionHash,
  })
}

function operationAt(
  ledger: OwnedDockerRecoveryLedger, operationSequence: number, role?: OwnedDockerResourceRole,
): { operation: OwnedDockerLedgerOperationV4; resource?: OwnedDockerLedgerResourceV4 } {
  const operation = ledger.listOperations().find(item => item.operationSequence === operationSequence)
  const resource = role === undefined ? undefined : operation?.resources.find(item => item.role === role)
  if (operation === undefined || (role !== undefined && resource === undefined)) {
    throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  }
  return resource === undefined ? { operation } : { operation, resource }
}

function recoverPreparedOperation(
  ledger: OwnedDockerRecoveryLedger,
  operationBindingHash: string,
): OwnedDockerPreparedOperationRecoveryResult {
  if (typeof operationBindingHash !== 'string' || !HASH.test(operationBindingHash)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const internal = ledgerInternals.get(ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  const recoveryEpoch = captureOwnedDockerRecoveryAuthorityEpoch(ledger)
  const release = internal.beginRecoveryDispatch(recoveryEpoch)
  try {
    internal.assertState('recovery', recoveryEpoch)
    const matches = ledger.listOperations().filter(operation =>
      operation.operationBindingHash === operationBindingHash)
    if (matches.length !== 1) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    const operation = matches[0]!
    if (operation.resources.length === 0 || operation.resources.some(resource =>
      resource.phase !== 'prepared' || resource.objectId !== null ||
      resource.boundProjectionHashV1 !== null)) {
      throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    }
    internal.assertState('recovery', recoveryEpoch)
    internal.deleteOperation('recovery', recoveryEpoch, operation.operationSequence)
    return Object.freeze({ kind: 'completed' as const, clearedOperations: 1 as const })
  } finally {
    release()
  }
}

/** @internal Only a pinned recovery transport may consume this read-only authority. */
export function consumeOwnedDockerAttemptedContainerRecoveryPermitV1(
  value: unknown,
  authority: OwnedDockerRecoveryLedger,
  recoveryEpoch: number,
): OwnedDockerCreateDescriptorV2 {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value) ||
    !isOwnedDockerRecoveryLedger(authority) || !Number.isSafeInteger(recoveryEpoch) || recoveryEpoch < 0) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const permit = value as OwnedDockerAttemptedContainerRecoveryPermitV1
  const state = attemptedContainerRecoveryPermitStates.get(permit)
  if (state === undefined || state.status !== 'active') throw fail('OWNED_DOCKER_INPUT_INVALID')
  // Every consume attempt burns this exact permit, including a cross-ledger or stale attempt.
  state.status = 'consumed'
  if (state.ledger !== authority || state.epoch !== recoveryEpoch) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const internal = ledgerInternals.get(authority)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  internal.assertState('recovery', recoveryEpoch)
  const current = operationAt(authority, state.operationSequence, 'worker')
  const expected = descriptor(current.operation, current.resource!)
  if (current.operation.operationBindingHash !== state.descriptor.operationBindingHash ||
    current.resource!.phase !== 'attempted' || current.resource!.resourceKind !== 'container' ||
    expected.version !== state.descriptor.version || expected.role !== state.descriptor.role ||
    expected.resourceKind !== state.descriptor.resourceKind || expected.name !== state.descriptor.name ||
    expected.createProjectionContract !== state.descriptor.createProjectionContract ||
    expected.createProjectionHash !== state.descriptor.createProjectionHash ||
    !labelsEqual(expected.labels, state.descriptor.labels)) {
    throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  }
  return state.descriptor
}

function mintAttemptedContainerRecoveryOutcome(
  permit: OwnedDockerAttemptedContainerRecoveryPermitV1,
  kind: 'found' | 'not-yet-visible',
  observed: OwnedDockerObservedResourceV2 | null,
): OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1 {
  if (typeof permit !== 'object' || permit === null || utilTypes.isProxy(permit)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const state = attemptedContainerRecoveryPermitStates.get(permit)
  if (state === undefined || state.status !== 'consumed') throw fail('OWNED_DOCKER_INPUT_INVALID')
  const internal = ledgerInternals.get(state.ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  internal.assertState('recovery', state.epoch)
  const current = operationAt(state.ledger, state.operationSequence, 'worker')
  if (current.operation.operationBindingHash !== state.descriptor.operationBindingHash ||
    current.resource!.phase !== 'attempted' || current.resource!.resourceKind !== 'container') {
    throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  }
  let snapshot: OwnedDockerObservedResourceV2 | null = null
  if (kind === 'found') {
    snapshot = validateObserved(observed)
    assertObserved(snapshot, current.operation, current.resource!)
  } else if (observed !== null) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  state.status = 'outcome-minted'
  const outcome = Object.freeze({
    [attemptedContainerRecoveryOutcomeBrand]: true as const,
    version: 1 as const,
    kind,
  }) as OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1
  attemptedContainerRecoveryOutcomeStates.set(outcome, {
    permit,
    observed: snapshot,
    status: 'active',
  })
  return outcome
}

/** @internal Mint exact found evidence after the pinned transport consumed its permit. */
export function mintOwnedDockerAttestedAttemptedContainerRecoveryFoundOutcomeV1(
  permit: OwnedDockerAttemptedContainerRecoveryPermitV1,
  observed: OwnedDockerObservedResourceV2,
): OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1 {
  return mintAttemptedContainerRecoveryOutcome(permit, 'found', observed)
}

/** @internal Mint exact absence-at-this-instant evidence; it never clears durable intent. */
export function mintOwnedDockerAttestedAttemptedContainerRecoveryNotYetVisibleOutcomeV1(
  permit: OwnedDockerAttemptedContainerRecoveryPermitV1,
): OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1 {
  return mintAttemptedContainerRecoveryOutcome(permit, 'not-yet-visible', null)
}

async function recoverAttemptedContainer(
  ledger: OwnedDockerRecoveryLedger,
  operationBindingHash: string,
  dispatch: (
    descriptor: OwnedDockerCreateDescriptorV2,
    permit: OwnedDockerAttemptedContainerRecoveryPermitV1,
  ) => Promise<OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1>,
): Promise<OwnedDockerAttemptedContainerRecoveryResult> {
  if (typeof operationBindingHash !== 'string' || !HASH.test(operationBindingHash) ||
    typeof dispatch !== 'function') throw fail('OWNED_DOCKER_INPUT_INVALID')
  const internal = ledgerInternals.get(ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  const recoveryEpoch = captureOwnedDockerRecoveryAuthorityEpoch(ledger)
  let rows = attemptedContainerRecoveryRowsInFlight.get(ledger)
  if (rows === undefined) {
    rows = new Set<string>()
    attemptedContainerRecoveryRowsInFlight.set(ledger, rows)
  }
  if (rows.has(operationBindingHash)) throw fail('OWNED_DOCKER_LEDGER_BUSY')
  rows.add(operationBindingHash)
  let release: (() => void) | null = null
  let permitState: AttemptedContainerRecoveryPermitState | null = null
  try {
    release = internal.beginRecoveryDispatch(recoveryEpoch)
    internal.assertState('recovery', recoveryEpoch)
    const matches = ledger.listOperations().filter(operation =>
      operation.operationBindingHash === operationBindingHash)
    if (matches.length !== 1) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    const operation = matches[0]!
    const resource = operation.resources.find(item => item.role === 'worker')
    if (resource === undefined || resource.phase !== 'attempted' ||
      resource.resourceKind !== 'container' || resource.objectId !== null ||
      resource.boundProjectionHashV1 !== null) {
      throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    }
    const createDescriptor = descriptor(operation, resource)
    const permit = Object.freeze({
      [attemptedContainerRecoveryPermitBrand]: true as const,
      version: 1 as const,
      operationBindingHash,
      role: 'worker' as const,
    })
    permitState = {
      ledger,
      epoch: recoveryEpoch,
      operationSequence: operation.operationSequence,
      descriptor: createDescriptor,
      status: 'active',
    }
    attemptedContainerRecoveryPermitStates.set(permit, permitState)
    let dispatched: OwnedDockerAttemptedContainerRecoveryDispatchOutcomeV1
    try {
      dispatched = await dispatch(createDescriptor, permit)
    } catch (error) {
      if (error instanceof OwnedDockerResourceError) throw error
      throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
    }
    const outcome = typeof dispatched === 'object' && dispatched !== null && !utilTypes.isProxy(dispatched)
      ? attemptedContainerRecoveryOutcomeStates.get(dispatched)
      : undefined
    if (outcome === undefined || outcome.status !== 'active' || outcome.permit !== permit ||
      permitState.status !== 'outcome-minted') {
      throw fail('OWNED_DOCKER_INPUT_INVALID')
    }
    outcome.status = 'consumed'
    internal.assertState('recovery', recoveryEpoch)
    const current = operationAt(ledger, operation.operationSequence, 'worker')
    if (current.operation.operationBindingHash !== operationBindingHash ||
      current.resource!.phase !== 'attempted' || current.resource!.resourceKind !== 'container') {
      throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    }
    if (outcome.observed === null) {
      return Object.freeze({ kind: 'not-yet-visible' as const })
    }
    assertObserved(outcome.observed, current.operation, current.resource!)
    internal.bind(
      recoveryEpoch,
      operation.operationSequence,
      'worker',
      outcome.observed.objectId,
      outcome.observed.projectionHashV1,
    )
    return Object.freeze({ kind: 'bound' as const })
  } finally {
    if (permitState !== null) permitState.status = 'revoked'
    release?.()
    rows.delete(operationBindingHash)
  }
}

function expectedBoundContainer(
  operation: OwnedDockerLedgerOperationV4,
  resource: OwnedDockerLedgerResourceV4,
): OwnedDockerObservedResourceV2 {
  if (resource.phase !== 'bound' || resource.role !== 'worker' ||
    resource.resourceKind !== 'container' || resource.objectId === null ||
    resource.boundProjectionHashV1 === null) {
    throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  }
  return Object.freeze({
    version: 2 as const,
    objectId: resource.objectId,
    resourceKind: 'container' as const,
    name: resource.name,
    labels: labelsFor(operation, resource.role),
    createProjectionContract: resource.createProjectionContract,
    createProjectionHash: resource.createProjectionHash,
    projectionHashV1: resource.boundProjectionHashV1,
    networkEndpointCount: null,
  })
}

/** @internal Only the pinned recovery cleanup transport may consume this one-shot authority. */
export function consumeOwnedDockerRecoveryBoundContainerCleanupPermitV1(
  value: unknown,
  authority: OwnedDockerRecoveryLedger,
  recoveryEpoch: number,
  endpointIdentity: unknown,
): OwnedDockerObservedResourceV2 {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const permit = value as OwnedDockerRecoveryBoundContainerCleanupPermitV1
  const state = recoveryBoundContainerCleanupPermitStates.get(permit)
  if (state === undefined || state.status !== 'active') {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  state.status = 'consumed'
  if (state.ledger !== authority || state.epoch !== recoveryEpoch) {
    throw fail('OWNED_DOCKER_EPOCH_STALE')
  }
  const consumingEndpoint = validateEndpointIdentity(endpointIdentity)
  if (!endpointEqual(consumingEndpoint, state.ledger.activation.endpointIdentity)) {
    throw fail('OWNED_DOCKER_ENDPOINT_MISMATCH')
  }
  const internal = ledgerInternals.get(state.ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  internal.assertState('recovery', recoveryEpoch)
  const current = operationAt(state.ledger, state.operationSequence, 'worker')
  const expected = expectedBoundContainer(current.operation, current.resource!)
  if (current.operation.operationBindingHash !== permit.operationBindingHash ||
    permit.objectId !== expected.objectId || !observedEqual(expected, state.expected)) {
    throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  }
  return state.expected
}

/** @internal Minted only after exact removal/absence and installation-wide zero proof. */
export function mintOwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1(
  permit: OwnedDockerRecoveryBoundContainerCleanupPermitV1,
  kind: 'removed' | 'absent',
): OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1 {
  const permitState = recoveryBoundContainerCleanupPermitStates.get(permit)
  if (permitState === undefined || permitState.status !== 'consumed' ||
    (kind !== 'removed' && kind !== 'absent')) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  permitState.status = 'outcome-minted'
  const outcome = Object.freeze({
    [recoveryBoundContainerCleanupOutcomeBrand]: true as const,
    version: 1 as const,
    kind,
  }) as OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1
  recoveryBoundContainerCleanupOutcomeStates.set(outcome, {
    permit,
    kind,
    status: 'active',
  })
  return outcome
}

async function recoverBoundContainer(
  ledger: OwnedDockerRecoveryLedger,
  operationBindingHash: string,
  dispatch: (
    expected: OwnedDockerObservedResourceV2,
    permit: OwnedDockerRecoveryBoundContainerCleanupPermitV1,
  ) => Promise<OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1>,
): Promise<OwnedDockerRecoveryBoundContainerCleanupResult> {
  if (typeof operationBindingHash !== 'string' || !HASH.test(operationBindingHash) ||
    typeof dispatch !== 'function') throw fail('OWNED_DOCKER_INPUT_INVALID')
  const internal = ledgerInternals.get(ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  const recoveryEpoch = captureOwnedDockerRecoveryAuthorityEpoch(ledger)
  let rows = recoveryBoundContainerRowsInFlight.get(ledger)
  if (rows === undefined) {
    rows = new Set<string>()
    recoveryBoundContainerRowsInFlight.set(ledger, rows)
  }
  if (rows.size !== 0) throw fail('OWNED_DOCKER_LEDGER_BUSY')
  rows.add(operationBindingHash)
  let release: (() => void) | null = null
  let permitState: RecoveryBoundContainerCleanupPermitState | null = null
  try {
    release = internal.beginRecoveryDispatch(recoveryEpoch)
    internal.assertState('recovery', recoveryEpoch)
    const matches = ledger.listOperations().filter(operation =>
      operation.operationBindingHash === operationBindingHash)
    if (matches.length !== 1 || matches[0]!.resources.length !== 1) {
      throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    }
    const operation = matches[0]!
    const resource = operation.resources[0]!
    const expected = expectedBoundContainer(operation, resource)
    const permit = Object.freeze({
      [recoveryBoundContainerCleanupPermitBrand]: true as const,
      version: 1 as const,
      operationBindingHash,
      role: 'worker' as const,
      objectId: expected.objectId,
    })
    permitState = {
      ledger,
      epoch: recoveryEpoch,
      operationSequence: operation.operationSequence,
      expected,
      status: 'active',
    }
    recoveryBoundContainerCleanupPermitStates.set(permit, permitState)
    let dispatched: OwnedDockerAttestedRecoveryBoundContainerCleanupOutcomeV1
    try {
      dispatched = await dispatch(expected, permit)
    } catch (error) {
      if (error instanceof OwnedDockerResourceError) throw error
      throw fail('OWNED_DOCKER_REMOVAL_AMBIGUOUS')
    }
    const outcome = typeof dispatched === 'object' && dispatched !== null &&
      !utilTypes.isProxy(dispatched)
      ? recoveryBoundContainerCleanupOutcomeStates.get(dispatched)
      : undefined
    if (outcome === undefined || outcome.status !== 'active' || outcome.permit !== permit ||
      permitState.status !== 'outcome-minted') {
      throw fail('OWNED_DOCKER_INPUT_INVALID')
    }
    outcome.status = 'consumed'
    internal.assertState('recovery', recoveryEpoch)
    const current = operationAt(ledger, operation.operationSequence, 'worker')
    if (current.operation.operationBindingHash !== operationBindingHash ||
      current.operation.resources.length !== 1 ||
      !observedEqual(expectedBoundContainer(current.operation, current.resource!), expected)) {
      throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
    }
    internal.deleteOperation('recovery', recoveryEpoch, operation.operationSequence)
    return Object.freeze({
      kind: 'completed' as const,
      clearedOperations: 1 as const,
      removedResources: outcome.kind === 'removed' ? 1 as const : 0 as const,
    })
  } finally {
    if (permitState !== null) permitState.status = 'revoked'
    release?.()
    rows.delete(operationBindingHash)
  }
}

/** @internal Only the pinned installation-zero transport may consume this authority. */
export function consumeOwnedDockerRecoveryActivationPermitV1(
  value: unknown,
  authority: OwnedDockerRecoveryLedger,
  recoveryEpoch: number,
  endpointIdentity: unknown,
): string {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const permit = value as OwnedDockerRecoveryActivationPermitV1
  const state = recoveryActivationPermitStates.get(permit)
  if (state === undefined || state.status !== 'active') {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  // Every consume attempt burns this exact permit, including cross-ledger,
  // stale-epoch and cross-endpoint attempts.
  state.status = 'consumed'
  if (state.ledger !== authority || state.epoch !== recoveryEpoch) {
    throw fail('OWNED_DOCKER_EPOCH_STALE')
  }
  const consumingEndpoint = validateEndpointIdentity(endpointIdentity)
  if (!endpointEqual(consumingEndpoint, state.ledger.activation.endpointIdentity)) {
    throw fail('OWNED_DOCKER_ENDPOINT_MISMATCH')
  }
  const internal = ledgerInternals.get(state.ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  internal.assertState('recovery', recoveryEpoch)
  assertDockerEndpoint(state.docker, state.ledger.activation.endpointIdentity)
  if (state.ledger.listOperations().length !== 0) throw fail('OWNED_DOCKER_RECOVERY_REQUIRED')
  return state.ledger.activation.installationId
}

/** @internal Minted synchronously at the end of a pinned installation-wide zero proof. */
export function mintOwnedDockerAttestedRecoveryActivationOutcomeV1(
  permit: OwnedDockerRecoveryActivationPermitV1,
): OwnedDockerAttestedRecoveryActivationOutcomeV1 {
  if (typeof permit !== 'object' || permit === null || utilTypes.isProxy(permit)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const permitState = recoveryActivationPermitStates.get(permit)
  if (permitState === undefined || permitState.status !== 'consumed') {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const internal = ledgerInternals.get(permitState.ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  internal.assertState('recovery', permitState.epoch)
  assertDockerEndpoint(permitState.docker, permitState.ledger.activation.endpointIdentity)
  if (permitState.ledger.listOperations().length !== 0) {
    throw fail('OWNED_DOCKER_RECOVERY_REQUIRED')
  }
  permitState.status = 'outcome-minted'
  const outcome = Object.freeze({
    [recoveryActivationOutcomeBrand]: true as const,
    version: 1 as const,
    kind: 'installation-zero' as const,
  }) as OwnedDockerAttestedRecoveryActivationOutcomeV1
  recoveryActivationOutcomeStates.set(outcome, { permit, status: 'active' })
  return outcome
}

/** @internal Commits only the exact outcome minted from the same one-shot permit. */
export function commitOwnedDockerRecoveryActivationOutcomeV1(
  permit: OwnedDockerRecoveryActivationPermitV1,
  outcomeValue: OwnedDockerAttestedRecoveryActivationOutcomeV1,
): void {
  if (typeof permit !== 'object' || permit === null || utilTypes.isProxy(permit) ||
    typeof outcomeValue !== 'object' || outcomeValue === null || utilTypes.isProxy(outcomeValue)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const permitState = recoveryActivationPermitStates.get(permit)
  const outcome = recoveryActivationOutcomeStates.get(outcomeValue)
  if (permitState === undefined || permitState.status !== 'outcome-minted' ||
    outcome === undefined || outcome.status !== 'active' || outcome.permit !== permit) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const { ledger, docker, epoch: recoveryEpoch } = permitState
  const internal = ledgerInternals.get(ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  internal.assertState('recovery', recoveryEpoch)
  assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
  if (ledger.listOperations().length !== 0) throw fail('OWNED_DOCKER_RECOVERY_REQUIRED')
  if (recoveryEpoch >= MAX_OPERATION_SEQUENCE) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  // Allocate and brand everything that can allocate before the durable SQLite
  // commit. No allocation remains after transitionToActive succeeds.
  const preparedActiveEpoch = makeActiveEpoch(ledger, docker, recoveryEpoch + 1)
  const preparedResult: OwnedDockerRecoveryResult = Object.freeze({
    kind: 'reconciled-and-activated' as const,
    clearedOperations: 0,
    removedResources: 0,
    activeEpoch: preparedActiveEpoch,
  })
  outcome.status = 'consumed'
  internal.activateAfterZero(recoveryEpoch)
  permitState.status = 'committed'
  permitState.committedResult = preparedResult
}

async function activateAfterInstallationZero(
  ledger: OwnedDockerRecoveryLedger,
  docker: OwnedDockerAttestedCommandPort,
  brokerValue: unknown,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<OwnedDockerRecoveryResult> {
  if (typeof docker !== 'object' || docker === null || utilTypes.isProxy(docker) ||
    typeof brokerValue !== 'object' || brokerValue === null || utilTypes.isProxy(brokerValue)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const brokerModule = await import('./docker-engine-pinned-session.js')
  if (!brokerModule.isNodeOwnedDockerEngineRecoveryBroker(brokerValue)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const brokerDescriptor = Object.getOwnPropertyDescriptor(
    brokerValue,
    'activateAfterInstallationZero',
  )
  if (brokerDescriptor === undefined || !('value' in brokerDescriptor) ||
    typeof brokerDescriptor.value !== 'function' || utilTypes.isProxy(brokerDescriptor.value)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const dispatch = brokerDescriptor.value as (
    permit: OwnedDockerRecoveryActivationPermitV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<void>
  const internal = ledgerInternals.get(ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
  const recoveryEpoch = captureOwnedDockerRecoveryAuthorityEpoch(ledger)
  const release = internal.beginRecoveryActivation(recoveryEpoch)
  let permitState: RecoveryActivationPermitState | null = null
  try {
    internal.assertState('recovery', recoveryEpoch)
    if (ledger.listOperations().length !== 0) throw fail('OWNED_DOCKER_RECOVERY_REQUIRED')
    const permit = Object.freeze({
      [recoveryActivationPermitBrand]: true as const,
      version: 1 as const,
    }) as OwnedDockerRecoveryActivationPermitV1
    permitState = {
      ledger, docker, epoch: recoveryEpoch, committedResult: null, status: 'active',
    }
    recoveryActivationPermitStates.set(permit, permitState)
    try {
      await Reflect.apply(dispatch, brokerValue, [permit, options])
    } catch (error) {
      // Activation is the durable commit point. A later transport close error
      // cannot honestly turn a committed active epoch back into a failure.
      if (permitState.status !== 'committed') {
        if (error instanceof OwnedDockerResourceError) throw error
        throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
      }
    }
    if (permitState.status !== 'committed' || permitState.committedResult === null) {
      throw fail('OWNED_DOCKER_INPUT_INVALID')
    }
    return permitState.committedResult
  } finally {
    if (permitState !== null && permitState.status !== 'committed') {
      permitState.status = 'revoked'
    }
    release()
  }
}

/** @internal Only the pinned Docker create transport may consume this one-shot authority. */
export function consumeOwnedDockerAttemptedCreatePermitV1(
  value: unknown,
): OwnedDockerCreateDescriptorV2 {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const permit = value as OwnedDockerAttemptedCreatePermitV1
  const state = attemptedCreatePermitStates.get(permit)
  if (state === undefined || state.status !== 'active') {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  state.status = 'consumed'

  assertDockerEndpoint(state.docker, state.ledger.activation.endpointIdentity)
  const internal = ledgerInternals.get(state.ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  internal.assertState('active', state.epoch)
  const current = operationAt(state.ledger, state.operationSequence, state.role)
  const expected = descriptor(current.operation, current.resource!)
  if (current.resource!.phase !== 'attempted' ||
    expected.version !== state.descriptor.version ||
    expected.operationBindingHash !== state.descriptor.operationBindingHash ||
    expected.role !== state.descriptor.role ||
    expected.resourceKind !== state.descriptor.resourceKind ||
    expected.name !== state.descriptor.name ||
    expected.createProjectionContract !== state.descriptor.createProjectionContract ||
    expected.createProjectionHash !== state.descriptor.createProjectionHash ||
    !labelsEqual(expected.labels, state.descriptor.labels)) {
    throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  }
  return state.descriptor
}

/** @internal Only the pinned Docker use transport may consume this one-shot authority. */
export function consumeOwnedDockerBoundContainerUsePermitV1(
  value: unknown,
  endpointIdentity: unknown,
): OwnedDockerBoundUseDescriptorV2 {
  if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const permit = value as OwnedDockerBoundContainerUsePermitV1
  const state = boundContainerUsePermitStates.get(permit)
  if (state === undefined || state.status !== 'active') {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  state.status = 'consumed'

  const consumingEndpoint = validateEndpointIdentity(endpointIdentity)
  if (!endpointEqual(consumingEndpoint, state.ledger.activation.endpointIdentity)) {
    throw fail('OWNED_DOCKER_ENDPOINT_MISMATCH')
  }
  assertDockerEndpoint(state.docker, state.ledger.activation.endpointIdentity)
  const internal = ledgerInternals.get(state.ledger)
  if (internal === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
  internal.assertState('active', state.epoch)
  const current = operationAt(state.ledger, state.operationSequence, state.role)
  const expected = descriptor(current.operation, current.resource!)
  if (current.resource!.phase !== 'bound' || current.resource!.resourceKind !== 'container' ||
    current.resource!.objectId !== state.descriptor.objectId ||
    current.resource!.boundProjectionHashV1 !== state.descriptor.boundProjectionHashV1 ||
    expected.version !== state.descriptor.version ||
    expected.operationBindingHash !== state.descriptor.operationBindingHash ||
    expected.role !== state.descriptor.role ||
    expected.resourceKind !== state.descriptor.resourceKind ||
    expected.name !== state.descriptor.name ||
    expected.createProjectionContract !== state.descriptor.createProjectionContract ||
    expected.createProjectionHash !== state.descriptor.createProjectionHash ||
    !labelsEqual(expected.labels, state.descriptor.labels)) {
    throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  }
  return state.descriptor
}

async function discover(
  ledger: OwnedDockerRecoveryLedger,
  docker: OwnedDockerAttestedCommandPort,
  epoch: number,
  operationSequence: number,
  role: OwnedDockerResourceRole,
): Promise<OwnedDockerObservedResourceV2> {
  const internal = ledgerInternals.get(ledger)!
  internal.assertState('active', epoch)
  let { operation, resource } = operationAt(ledger, operationSequence, role)
  const planned = resource!
  if (planned.phase === 'prepared') throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
  if (planned.phase === 'bound' && planned.objectId !== null) {
    const byId = validateInspect(await portCall(ledger, docker, () => docker.inspectById({
      resourceKind: planned.resourceKind, objectId: planned.objectId!,
    })))
    if (byId.kind !== 'found') throw byId.kind === 'ambiguous'
      ? fail('OWNED_DOCKER_DAEMON_AMBIGUOUS') : fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
    assertObserved(byId.resource, operation, planned)
    return byId.resource
  }
  const all = ledger.listOperations()
  const scan = await scanAndValidate(ledger, docker, all)
  const found = scan.get(resourceKey(operation.operationBindingHash, role)) ?? null
  const named = validateInspect(await portCall(ledger, docker, () => docker.inspectByName({
    resourceKind: planned.resourceKind, name: planned.name,
  })))
  if (named.kind === 'ambiguous') throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
  if (found === null && named.kind === 'absent') throw fail('OWNED_DOCKER_CREATE_UNRESOLVED')
  if (found === null || named.kind === 'absent' || !observedEqual(named.resource, found)) {
    throw fail('OWNED_DOCKER_DAEMON_AMBIGUOUS')
  }
  const immutable = validateInspect(await portCall(ledger, docker, () => docker.inspectById({
    resourceKind: planned.resourceKind, objectId: found.objectId,
  })))
  if (immutable.kind !== 'found' || !observedEqual(immutable.resource, found)) {
    throw immutable.kind === 'ambiguous'
      ? fail('OWNED_DOCKER_DAEMON_AMBIGUOUS') : fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
  }
  assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
  internal.assertState('active', epoch)
  internal.bind(epoch, operationSequence, role, found.objectId, found.projectionHashV1)
  ;({ operation, resource } = operationAt(ledger, operationSequence, role))
  return found
}

function makeActiveEpoch(
  ledger: OwnedDockerRecoveryLedger,
  docker: OwnedDockerAttestedCommandPort,
  epoch: number,
): OwnedDockerActiveEpoch {
  const internal = ledgerInternals.get(ledger)!
  const active: OwnedDockerActiveEpoch = {
    [activeEpochBrand]: true as const,
    epoch,
    prepare(value: OwnedDockerCoordinatorPrepareInputV2): OwnedDockerOperationHandle {
      const request = validatePrepare(value)
      assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
      internal.assertState('active', epoch)
      let operationSequence = 0
      try {
        const transaction = internal.handle.db.transaction(() => {
          internal.assertState('active', epoch)
          const manager = readManager(internal.handle.db)
          if (manager.operationSequence >= MAX_OPERATION_SEQUENCE) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
          const sequence = manager.operationSequence + 1
          const operationHash = operationBinding(manager, epoch, sequence)
          const base = {
            version: 4 as const,
            operationSequence: sequence,
            managerEpoch: epoch,
            installationId: manager.installationId,
            ownerBindingHash: ownerBinding(manager),
            sessionBindingHash: sessionBinding(manager, epoch),
            operationBindingHash: operationHash,
            sidecarKind: request.sidecarKind,
            policyHash: request.policyHash,
          }
          const advancedManager: ManagerRow = { ...manager, operationSequence: sequence }
          const advanced = internal.handle.db.prepare(
            "UPDATE ledger_meta SET operation_seq = ?, integrity_hash = ? WHERE singleton = 1 AND manager_state = 'active' AND manager_epoch = ? AND operation_seq = ? AND integrity_hash = ?",
          ).run(sequence, managerIntegrity(advancedManager), epoch, manager.operationSequence,
            managerIntegrity(manager))
          if (advanced.changes !== 1) throw fail('OWNED_DOCKER_EPOCH_STALE')
          internal.handle.db.prepare(
            'INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(sequence, operationHash, epoch, base.ownerBindingHash, base.sessionBindingHash,
            base.sidecarKind, base.policyHash, operationIntegrity(base))
          const insert = internal.handle.db.prepare(
            "INSERT INTO resources VALUES (?, ?, ?, ?, ?, ?, NULL, 'prepared', ?, NULL, NULL)",
          )
          for (const resource of request.resources) {
            const name = resourceName(operationHash, request.sidecarKind, resource.role)
            insert.run(sequence, resource.role, resource.resourceKind, name,
              resource.createProjectionContract, resource.createProjectionHash,
              resourceIntegrity({
                operationSequence: sequence, role: resource.role,
                resourceKind: resource.resourceKind, name,
                createProjectionContract: resource.createProjectionContract,
                createProjectionHash: resource.createProjectionHash,
                boundProjectionHashV1: null, phase: 'prepared',
              }))
          }
          return sequence
        })
        operationSequence = transaction.immediate()
      } catch (error) {
        if (error instanceof OwnedDockerResourceError) throw error
        throw fail('OWNED_DOCKER_LEDGER_UNAVAILABLE')
      }
      const initial = operationAt(ledger, operationSequence).operation
      const descriptors = Object.freeze(initial.resources.map(resource => descriptor(initial, resource)))
      let lifecycle: 'open' | 'closing' | 'terminal' = 'open'
      let operationInFlight = 0
      const noDiscoveryOutcomeRoles = new Set<OwnedDockerResourceRole>()
      const beginOperationDispatch = (): (() => void) => {
        if (lifecycle !== 'open') {
          throw fail(lifecycle === 'closing' ? 'OWNED_DOCKER_LEDGER_BUSY' : 'OWNED_DOCKER_LEDGER_CONFLICT')
        }
        assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
        const releaseGlobal = internal.beginTrustedDispatch(epoch)
        operationInFlight += 1
        let released = false
        return () => {
          if (released) return
          released = true
          operationInFlight -= 1
          releaseGlobal()
        }
      }
      const makeBound = (
        role: OwnedDockerResourceRole, objectId: string,
      ): OwnedDockerBoundResourceHandle => {
        const withBound = async <T>(dispatch: (
          value: OwnedDockerBoundUseDescriptorV2,
          current: ReturnType<typeof operationAt>,
        ) => Promise<T>): Promise<T> => {
          if (typeof dispatch !== 'function') throw fail('OWNED_DOCKER_INPUT_INVALID')
          const release = beginOperationDispatch()
          try {
            const current = operationAt(ledger, operationSequence, role)
            if (current.resource!.phase !== 'bound' || current.resource!.objectId !== objectId) {
              throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
            }
            const inspected = validateInspect(await portCall(ledger, docker, () => docker.inspectById({
              resourceKind: current.resource!.resourceKind, objectId,
            })))
            if (inspected.kind !== 'found') throw inspected.kind === 'ambiguous'
              ? fail('OWNED_DOCKER_DAEMON_AMBIGUOUS') : fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
            assertObserved(inspected.resource, current.operation, current.resource!)
            assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
            internal.assertState('active', epoch)
            const useDescriptor = Object.freeze({
              ...descriptor(current.operation, current.resource!), objectId,
              boundProjectionHashV1: current.resource!.boundProjectionHashV1!,
            })
            let result: T
            try {
              result = await dispatch(useDescriptor, current)
            } catch (error) {
              // Endpoint replacement dominates, otherwise preserve the caller error.
              assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
              throw error
            }
            assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
            return result
          } finally {
            release()
          }
        }
        return Object.freeze({
          operationBindingHash: initial.operationBindingHash,
          role,
          objectId,
          use<T>(dispatch: (value: OwnedDockerBoundUseDescriptorV2) => Promise<T>): Promise<T> {
            return withBound((value) => dispatch(value))
          },
          useContainer<T>(dispatch: (
            value: OwnedDockerBoundUseDescriptorV2,
            permit: OwnedDockerBoundContainerUsePermitV1,
          ) => Promise<T>): Promise<T> {
            if (typeof dispatch !== 'function') throw fail('OWNED_DOCKER_INPUT_INVALID')
            return withBound(async (value, current) => {
              if (current.resource!.resourceKind !== 'container') {
                throw fail('OWNED_DOCKER_INPUT_INVALID')
              }
              const permit = Object.freeze({
                [boundContainerUsePermitBrand]: true as const,
                version: 1 as const,
                operationBindingHash: value.operationBindingHash,
                role: value.role,
                objectId: value.objectId,
              })
              const state: BoundContainerUsePermitState = {
                ledger,
                docker,
                epoch,
                operationSequence,
                role,
                descriptor: value,
                status: 'active',
              }
              boundContainerUsePermitStates.set(permit, state)
              try {
                return await dispatch(value, permit)
              } finally {
                state.status = 'revoked'
              }
            })
          },
        })
      }
      const operation: OwnedDockerOperationHandle = Object.freeze({
        [operationHandleBrand]: true as const,
        operationBindingHash: initial.operationBindingHash,
        resources: descriptors,
        async create(
          role: OwnedDockerResourceRole,
          dispatch: (
            value: OwnedDockerCreateDescriptorV2,
            permit: OwnedDockerAttemptedCreatePermitV1,
          ) => Promise<void | OwnedDockerCreateDispatchOutcomeV1>,
        ) {
          if (!validRole(role) || typeof dispatch !== 'function') throw fail('OWNED_DOCKER_INPUT_INVALID')
          const createDescriptor = descriptors.find(item => item.role === role)
          if (createDescriptor === undefined) throw fail('OWNED_DOCKER_INPUT_INVALID')
          const release = beginOperationDispatch()
          try {
            const current = operationAt(ledger, operationSequence, role)
            if (current.resource!.phase === 'attempted' && noDiscoveryOutcomeRoles.has(role)) {
              throw fail('OWNED_DOCKER_CREATE_UNRESOLVED')
            }
            if (current.resource!.phase === 'prepared') {
              internal.assertState('active', epoch)
              const attempted = internal.handle.db.prepare(
                "UPDATE resources SET phase = 'attempted', integrity_hash = ? WHERE operation_seq = ? AND role = ? AND phase = 'prepared' AND object_id IS NULL",
              ).run(resourceIntegrity({
                operationSequence,
                role: current.resource!.role,
                resourceKind: current.resource!.resourceKind,
                name: current.resource!.name,
                createProjectionContract: current.resource!.createProjectionContract,
                createProjectionHash: current.resource!.createProjectionHash,
                boundProjectionHashV1: null,
                phase: 'attempted',
              }),
                operationSequence, role)
              if (attempted.changes !== 1) throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
              internal.assertState('active', epoch)
              const permit = Object.freeze({
                [attemptedCreatePermitBrand]: true as const,
                version: 1 as const,
                operationBindingHash: createDescriptor.operationBindingHash,
                role,
              })
              const permitState: AttemptedCreatePermitState = {
                ledger,
                docker,
                epoch,
                operationSequence,
                role,
                descriptor: createDescriptor,
                status: 'active',
              }
              attemptedCreatePermitStates.set(permit, permitState)
              let dispatched: void | OwnedDockerCreateDispatchOutcomeV1 = undefined
              let legacyDispatchFailure = false
              let permitConsumed = false
              try {
                dispatched = await dispatch(createDescriptor, permit)
              } catch {
                legacyDispatchFailure = true
              } finally {
                permitConsumed = permitState.status === 'consumed'
                permitState.status = 'revoked'
              }
              if (permitConsumed || (!legacyDispatchFailure && dispatched !== undefined)) {
                noDiscoveryOutcomeRoles.add(role)
                if (legacyDispatchFailure || dispatched === undefined) {
                  throw fail('OWNED_DOCKER_CREATE_UNRESOLVED')
                }
                assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
                internal.assertState('active', epoch)
                const outcome = validateCreateDispatchOutcome(dispatched)
                if (outcome.kind === 'create-ambiguous') {
                  throw fail('OWNED_DOCKER_CREATE_UNRESOLVED')
                }
                if (!permitConsumed) throw fail('OWNED_DOCKER_INPUT_INVALID')
                const attemptedState = operationAt(ledger, operationSequence, role)
                if (attemptedState.resource!.phase !== 'attempted') {
                  throw fail('OWNED_DOCKER_LEDGER_CONFLICT')
                }
                assertObserved(outcome.observed, attemptedState.operation, attemptedState.resource!)
                assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
                internal.assertState('active', epoch)
                internal.bind(
                  epoch,
                  operationSequence,
                  role,
                  outcome.observed.objectId,
                  outcome.observed.projectionHashV1,
                )
                return makeBound(role, outcome.observed.objectId)
              }
            }
            const observed = await discover(ledger, docker, epoch, operationSequence, role)
            return makeBound(role, observed.objectId)
          } finally {
            release()
          }
        },
        async complete() {
          if (lifecycle !== 'open' || operationInFlight !== 0) {
            throw fail(lifecycle === 'terminal' ? 'OWNED_DOCKER_LEDGER_CONFLICT' : 'OWNED_DOCKER_LEDGER_BUSY')
          }
          assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
          const finish = internal.beginActiveCompletion(epoch)
          lifecycle = 'closing'
          try {
            const result = await reconcileScope({ ledger, docker, state: 'active', epoch, operationSequence })
            lifecycle = 'terminal'
            finish(true)
            return result
          } catch (error) {
            lifecycle = 'open'
            finish(false)
            throw error
          }
        },
      })
      operationHandleProvenance.set(operation, Object.freeze({
        activeEpoch: active,
        operationSequence,
      }))
      return operation
    },
  }
  Object.freeze(active)
  activeEpochProvenance.set(active, Object.freeze({ ledger, docker, epoch }))
  return active
}

/**
 * Reconcile the full installation while in recovery and prove it empty.
 * Activation is deliberately separate and requires a genuine pinned broker;
 * this structural semantic port can never mint an active epoch.
 */
export async function reconcileOwnedDockerResources(input: Readonly<{
  ledger: OwnedDockerRecoveryLedger
  docker: OwnedDockerAttestedCommandPort
}>): Promise<OwnedDockerScopedCompletionResult> {
  const record = exactRecord(input, ['ledger', 'docker'])
  if (record === null || typeof record['ledger'] !== 'object' || record['ledger'] === null ||
    typeof record['docker'] !== 'object' || record['docker'] === null ||
    !ledgerInternals.has(record['ledger'] as OwnedDockerRecoveryLedger)) {
    throw fail('OWNED_DOCKER_INPUT_INVALID')
  }
  const ledger = record['ledger'] as OwnedDockerRecoveryLedger
  const docker = record['docker'] as OwnedDockerAttestedCommandPort
  const internal = ledgerInternals.get(ledger)!
  assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
  // Validate the complete durable graph before rotating the manager epoch or
  // touching Docker. Corrupt intent must never cause either internal or
  // external side effects.
  ledger.listOperations()
  const recoveryEpoch = internal.enterRecovery()
  const reconciled = await reconcileScope({ ledger, docker, state: 'recovery', epoch: recoveryEpoch,
    operationSequence: null })
  internal.assertState('recovery', recoveryEpoch)
  const finalScan = validateScan(await portCall(ledger, docker,
    () => docker.scanInstallation(ledger.activation.installationId)))
  if (finalScan.kind !== 'ok' || finalScan.resources.length !== 0) {
    throw fail('OWNED_DOCKER_OWNERSHIP_UNPROVEN')
  }
  internal.assertState('recovery', recoveryEpoch)
  assertDockerEndpoint(docker, ledger.activation.endpointIdentity)
  return Object.freeze({
    kind: 'completed',
    clearedOperations: reconciled.clearedOperations,
    removedResources: reconciled.removedResources,
  })
}

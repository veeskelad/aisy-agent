import {
  makeContextLeaseCoordinator,
  makeConfinementPort,
  makeProjectRegistryV2,
  makeProjectService,
  makeSessionRotationAuthority,
  makeSwitchAuthority,
  type ContextLeaseCoordinator,
  type ConfinementEvent,
  type ConfinementPort,
  type ProjectRegistryV2,
  type ProjectRegistryV2Policy,
  type ProjectService,
  type ProjectServiceEvent,
  type SessionRotationAuthority,
  type ProjectServiceLifecycleDeps,
  type SwitchAuthority,
} from '@aisy/core'
import { createHash } from 'node:crypto'
import { makeNodeConfinementProcessPort } from './confinement-sidecar.js'
import { makeConfinementTreeScanner } from './confinement-tree-scanner.js'
import { makeNodeProjectRegistryV2Store } from './project-registry-v2-store.js'
import {
  makeNodeProjectProvisioner,
  type ProjectProvisioner,
} from './project-provisioner.js'
import { makeNodeSwitchAuthorityNonceStore } from './switch-authority-nonce-store.js'
import {
  makeBackgroundTurnRuntimeFactory,
  makeInteractiveTurnRuntimeFactory,
  type BackgroundTurnRuntimeFactory,
  type InteractiveTurnRuntimeDeps,
  type InteractiveTurnRuntimeFactory,
} from './interactive-turn-runtime.js'
import type { NodeAttachmentImportRuntime } from './attachment-import-runtime.js'
import {
  makeNodeLeaseBoundDockerBash,
  type NodeLeaseBoundDockerBashOptions,
} from './lease-bound-docker-bash.js'

export interface NodeProjectServiceRuntime {
  registry: ProjectRegistryV2
  authority: SwitchAuthority
  rotationAuthority?: SessionRotationAuthority
  leases: ContextLeaseCoordinator
  service: ProjectService
}

export interface NodeProjectRuntime extends NodeProjectServiceRuntime {
  confinement: ConfinementPort
  provisioner: ProjectProvisioner
}

export function makeNodeInteractiveTurnRuntimeFactory(input: {
  runtime: NodeProjectRuntime
  deps: Omit<
    InteractiveTurnRuntimeDeps,
    'service' | 'leases' | 'confinement'
  >
}): InteractiveTurnRuntimeFactory {
  return makeInteractiveTurnRuntimeFactory({
    ...input.deps,
    service: input.runtime.service,
    leases: input.runtime.leases,
    confinement: input.runtime.confinement,
  })
}

/**
 * Preview-safe composition that exposes the durable attachment importer to the
 * lease-bound tool executor and hides installed-but-unpublished imports from
 * all file reads. Construction does not activate v2 routing.
 */
export function makeNodeAttachmentAwareInteractiveTurnRuntimeFactory(input: {
  runtime: Pick<NodeProjectRuntime, 'service' | 'leases' | 'confinement'>
  attachments: NodeAttachmentImportRuntime
  deps: Omit<
    InteractiveTurnRuntimeDeps,
    'service' | 'leases' | 'confinement' | 'importAttachment'
  >
}): InteractiveTurnRuntimeFactory {
  return makeInteractiveTurnRuntimeFactory({
    ...input.deps,
    service: input.runtime.service,
    leases: input.runtime.leases,
    confinement: input.attachments.wrapConfinement(input.runtime.confinement),
    importAttachment: (lease, fileId, destination) =>
      input.attachments.service.importAttachment(lease, fileId, destination),
  })
}

/**
 * Production-preview composition for the complete Project file surface:
 * manifest-aware attachment reads plus one-shot lease-bound Docker bash.
 * Construction never contacts Docker and does not activate v2 routing.
 */
export function makeNodeProjectToolsInteractiveTurnRuntimeFactory(input: {
  runtime: Pick<NodeProjectRuntime, 'service' | 'leases' | 'confinement'>
  attachments: Pick<NodeAttachmentImportRuntime, 'service' | 'wrapConfinement'>
  bash: Omit<NodeLeaseBoundDockerBashOptions, 'leases'>
  deps: Omit<
    InteractiveTurnRuntimeDeps,
    'service' | 'leases' | 'confinement' | 'importAttachment' | 'runBash'
  >
}): InteractiveTurnRuntimeFactory {
  const runBash = makeNodeLeaseBoundDockerBash({
    ...input.bash,
    leases: input.runtime.leases,
  })
  return makeInteractiveTurnRuntimeFactory({
    ...input.deps,
    service: input.runtime.service,
    leases: input.runtime.leases,
    confinement: input.attachments.wrapConfinement(input.runtime.confinement),
    importAttachment: (lease, fileId, destination) =>
      input.attachments.service.importAttachment(lease, fileId, destination),
    runBash,
  })
}

export function makeNodeBackgroundTurnRuntimeFactory(input: {
  runtime: NodeProjectRuntime
  deps: Omit<
    InteractiveTurnRuntimeDeps,
    'service' | 'leases' | 'confinement'
  >
}): BackgroundTurnRuntimeFactory {
  return makeBackgroundTurnRuntimeFactory({
    ...input.deps,
    service: input.runtime.service,
    leases: input.runtime.leases,
    confinement: input.runtime.confinement,
  })
}

/**
 * Production composition seam for the v2 context runtime. Constructing it is
 * side-effect free apart from creating/loading the protected nonce store; it
 * does not activate the v2 registry or perform a migration cutover.
 */
export function makeNodeProjectServiceRuntime(input: {
  registry: ProjectRegistryV2
  authoritySecret: Uint8Array
  noncePath: string
  rotationNoncePath?: string
  nowMs?: () => number
  newReceiptId: () => string
  newLeaseId: () => string
  lifecycle?: ProjectServiceLifecycleDeps
  beforeArchive?: (event: ProjectServiceEvent) => void | Promise<void>
  emit?: (event: ProjectServiceEvent) => void
}): NodeProjectServiceRuntime {
  const nowMs = input.nowMs ?? Date.now
  const authority = makeSwitchAuthority({
    secret: input.authoritySecret,
    nowMs,
    newId: input.newReceiptId,
    nonces: makeNodeSwitchAuthorityNonceStore({ path: input.noncePath, nowMs }),
  })
  const rotationAuthority = input.rotationNoncePath === undefined
    ? undefined
    : makeSessionRotationAuthority({
        secret: createHash('sha256')
          .update(Buffer.from(input.authoritySecret))
          .update('\0aisy-session-rotation-v1')
          .digest(),
        nowMs,
        newId: input.newReceiptId,
        nonces: makeNodeSwitchAuthorityNonceStore({
          path: input.rotationNoncePath,
          nowMs,
        }),
      })
  const leases = makeContextLeaseCoordinator({ newId: input.newLeaseId })
  const service = makeProjectService({
    registry: input.registry,
    leases,
    authority,
    ...(rotationAuthority === undefined ? {} : { rotationAuthority }),
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
    ...(input.beforeArchive === undefined ? {} : { beforeArchive: input.beforeArchive }),
    ...(input.emit === undefined ? {} : { emit: input.emit }),
  })
  return {
    registry: input.registry,
    authority,
    ...(rotationAuthority === undefined ? {} : { rotationAuthority }),
    leases,
    service,
  }
}

export function makeNodeProjectServiceRuntimeFromRegistry(input: {
  registryPath: string
  registryPolicy: ProjectRegistryV2Policy
  authoritySecret: Uint8Array
  noncePath: string
  rotationNoncePath?: string
  nowMs?: () => number
  nowIso: () => string
  newRegistryId: () => string
  newReceiptId: () => string
  newLeaseId: () => string
  lifecycle?: ProjectServiceLifecycleDeps
  beforeArchive?: (event: ProjectServiceEvent) => void | Promise<void>
  emit?: (event: ProjectServiceEvent) => void
}): NodeProjectServiceRuntime {
  const store = makeNodeProjectRegistryV2Store({
    path: input.registryPath,
    policy: input.registryPolicy,
  })
  const registry = makeProjectRegistryV2({
    state: store.load(),
    policy: input.registryPolicy,
    nowIso: input.nowIso,
    newId: input.newRegistryId,
    persistence: store,
  })
  return makeNodeProjectServiceRuntime({
    registry,
    authoritySecret: input.authoritySecret,
    noncePath: input.noncePath,
    ...(input.rotationNoncePath === undefined
      ? {}
      : { rotationNoncePath: input.rotationNoncePath }),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    newReceiptId: input.newReceiptId,
    newLeaseId: input.newLeaseId,
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
    ...(input.beforeArchive === undefined ? {} : { beforeArchive: input.beforeArchive }),
    ...(input.emit === undefined ? {} : { emit: input.emit }),
  })
}

export function makeNodeProjectRuntimeFromRegistry(input: {
  registryPath: string
  registryPolicy: ProjectRegistryV2Policy
  authoritySecret: Uint8Array
  noncePath: string
  projectsRoot: string
  controlRoot: string
  nowMs?: () => number
  nowIso: () => string
  newRegistryId: () => string
  newReceiptId: () => string
  newLeaseId: () => string
  newProvisioningId: () => string
  pythonExecutable: string
  confinementWorkerPath: string
  newConfinementRequestId: () => string
  lifecycle?: ProjectServiceLifecycleDeps
  emit?: (event: ProjectServiceEvent) => void
  emitConfinement?: (event: ConfinementEvent) => void
}): NodeProjectRuntime {
  const runtime = makeNodeProjectServiceRuntimeFromRegistry(input)
  const confinementProcess = makeNodeConfinementProcessPort({
    pythonExecutable: input.pythonExecutable,
    workerPath: input.confinementWorkerPath,
  })
  const confinement = makeConfinementPort({
    leases: runtime.leases,
    process: confinementProcess,
    newId: input.newConfinementRequestId,
    ...(input.emitConfinement === undefined ? {} : { emit: input.emitConfinement }),
  })
  const treeScanner = makeConfinementTreeScanner({
    process: confinementProcess,
    newId: input.newConfinementRequestId,
  })
  const provisioner = makeNodeProjectProvisioner({
    service: runtime.service,
    treeScanner,
    projectsRoot: input.projectsRoot,
    controlRoot: input.controlRoot,
    newId: input.newProvisioningId,
  })
  return { ...runtime, confinement, provisioner }
}

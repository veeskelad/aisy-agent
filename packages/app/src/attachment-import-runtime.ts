import { join, resolve } from 'node:path'
import {
  AttachmentImportError,
  makeAttachmentImportService,
  type AttachmentImportFilePort,
  type AttachmentImportService,
  type ConfinementPort,
} from '@aisy/core'
import type { NodeProjectServiceRuntime } from './project-service-runtime.js'
import {
  makeNodeAttachmentImportFilePort,
  makeNodeAttachmentWorkerProcessPort,
  type AttachmentWorkerProcessPort,
} from './attachment-import-sidecar.js'
import {
  makeNodeAttachmentImportPersistence,
  type AttachmentImportStoreFault,
  type NodeAttachmentImportPersistence,
} from './attachment-import-store.js'
import { makeManifestAwareConfinementPort } from './manifest-aware-confinement.js'

export interface NodeAttachmentImportRuntime {
  service: AttachmentImportService
  persistence: NodeAttachmentImportPersistence
  files: AttachmentImportFilePort
  stateRoot: string
  stagingRoot: string
  wrapConfinement(delegate: ConfinementPort): ConfinementPort
}

/**
 * Production composition seam for ADR-0060 attachment imports. Construction
 * creates only protected control directories; it neither activates v2 routing
 * nor exposes import_attachment to the model or Telegram gateway.
 */
export function makeNodeAttachmentImportRuntime(input: {
  runtime: Pick<NodeProjectServiceRuntime, 'leases' | 'service'>
  controlRoot: string
  inboxRoot: string
  pythonExecutable: string
  workerPath: string
  maxAttachmentBytes: number
  newRequestId: () => string
  nowIso?: () => string
  process?: AttachmentWorkerProcessPort
  faultAtStore?: (point: AttachmentImportStoreFault) => void
  faultAtFile?: (point: 'after-stage' | 'after-install') => void
}): NodeAttachmentImportRuntime {
  const importRoot = join(resolve(input.controlRoot), 'attachment-import')
  const stateRoot = join(importRoot, 'state')
  const stagingRoot = join(importRoot, 'staging')
  const process = input.process ?? makeNodeAttachmentWorkerProcessPort({
    pythonExecutable: input.pythonExecutable,
    workerPath: input.workerPath,
  })
  const files = makeNodeAttachmentImportFilePort({
    process,
    inboxRoot: input.inboxRoot,
    stagingRoot,
    maxAttachmentBytes: input.maxAttachmentBytes,
    newRequestId: input.newRequestId,
    ...(input.faultAtFile === undefined ? {} : { faultAt: input.faultAtFile }),
  })
  const persistence = makeNodeAttachmentImportPersistence({
    stateRoot,
    inbox: files,
    ...(input.faultAtStore === undefined ? {} : { faultAt: input.faultAtStore }),
  })
  const service = makeAttachmentImportService({
    leases: input.runtime.leases,
    persistence,
    files,
    assertTargetUsable: (lease) => {
      if (!input.runtime.service.isBindingActive({
        operatorId: lease.operatorId,
        profileId: lease.profileId,
        projectId: lease.projectId,
        sessionId: lease.sessionId,
        scope: 'session',
      })) throw new AttachmentImportError('TARGET_UNAVAILABLE')
    },
    maxAttachmentBytes: input.maxAttachmentBytes,
    nowIso: input.nowIso ?? (() => new Date().toISOString()),
  })
  return Object.freeze<NodeAttachmentImportRuntime>({
    service,
    persistence,
    files,
    stateRoot,
    stagingRoot,
    wrapConfinement: delegate => makeManifestAwareConfinementPort({
      delegate,
      leases: input.runtime.leases,
      manifests: persistence,
      files,
    }),
  })
}

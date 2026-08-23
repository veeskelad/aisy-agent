import {
  makeProjectLifecycleAuthority,
  type ProjectLifecycleAuthorityIssuer,
  type ProjectServiceLifecycleDeps,
  type ProjectRecordV2,
} from '@aisy/core'

import { makeNodeMemoryPermanenceNonceStore } from './memory-permanence-nonce-store.js'

export interface NodeProjectLifecycleAuthorityRuntime {
  authority: ProjectLifecycleAuthorityIssuer
  lifecycle: ProjectServiceLifecycleDeps
}

/**
 * Production-preview lifecycle authority. It is deliberately separate from
 * switch authority and does not register commands or activate a transport.
 */
export function makeNodeProjectLifecycleAuthorityRuntime(input: {
  secret: Uint8Array
  noncePath: string
  newReceiptId: () => string
  validateRestorableRoot(project: Readonly<ProjectRecordV2>): Promise<void> | void
  nowMs?: () => number
}): NodeProjectLifecycleAuthorityRuntime {
  const nowMs = input.nowMs ?? Date.now
  const authority = makeProjectLifecycleAuthority({
    secret: input.secret,
    nowMs,
    newId: input.newReceiptId,
    nonces: makeNodeMemoryPermanenceNonceStore({ path: input.noncePath, nowMs }),
  })
  return Object.freeze({
    authority,
    lifecycle: Object.freeze({
      authority,
      validateRestorableRoot: input.validateRestorableRoot,
    }),
  })
}

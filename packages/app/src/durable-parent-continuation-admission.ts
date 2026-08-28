import { createHash } from 'node:crypto'

import {
  durableParentContinuationHash,
  type DurableParentContinuationCaptureV1,
  type DurableParentContinuationIdentityV1,
  type DurableParentContinuationRecordV1,
  type DurableParentContinuationStoreV1,
} from './durable-parent-continuation.js'

const ORPHAN_RECEIPT_DOMAIN = 'aisy.durable-parent-continuation.orphan-retirement.v1\0'
const FAILURE_RECEIPT_DOMAIN = 'aisy.durable-parent-continuation.failed-turn.v1\0'

/**
 * A code-owned receipt for an active parent turn that ended without a durable
 * ambiguity. It carries no dialogue and authorises only the exact CAS record.
 */
export function durableParentFailedTurnReceiptHash(
  record: DurableParentContinuationRecordV1,
): string {
  return createHash('sha256').update(FAILURE_RECEIPT_DOMAIN, 'utf8')
    .update(JSON.stringify([
      record.continuationHash,
      record.identity.supervisorBindingHash,
      record.revision,
    ]), 'utf8')
    .digest('hex')
}

/**
 * Retires only the exact active record captured by the failing turn. Runtime
 * proof remains composition-owned; record selection and CAS stay code-owned.
 */
export function retireDurableParentFailedTurn(input: Readonly<{
  store: DurableParentContinuationStoreV1
  expected: DurableParentContinuationRecordV1
  canRetire(record: DurableParentContinuationRecordV1): boolean
}>): DurableParentContinuationRecordV1 {
  const loaded = input.store.load()
  if (loaded.status !== 'ready' || loaded.record.phase !== 'active' ||
    loaded.record.ambiguity !== undefined ||
    loaded.record.continuationHash !== input.expected.continuationHash ||
    loaded.record.ownerId !== input.expected.ownerId ||
    loaded.record.revision !== input.expected.revision ||
    !input.canRetire(loaded.record)) {
    throw new Error('DURABLE_PARENT_CONTINUATION_FAILURE_RETIRE_DENIED')
  }
  return input.store.retire({
    continuationHash: loaded.record.continuationHash,
    ownerId: loaded.record.ownerId,
    expectedRevision: loaded.record.revision,
    terminalReceiptHash: durableParentFailedTurnReceiptHash(loaded.record),
  })
}

function orphanRetirementReceiptHash(
  record: DurableParentContinuationRecordV1,
  nextIdentity: DurableParentContinuationIdentityV1,
): string {
  return createHash('sha256').update(ORPHAN_RECEIPT_DOMAIN, 'utf8')
    .update(JSON.stringify([
      record.continuationHash,
      record.identity.supervisorBindingHash,
      record.revision,
      durableParentContinuationHash(nextIdentity),
      nextIdentity.supervisorBindingHash,
    ]), 'utf8')
    .digest('hex')
}

/**
 * Admits a fresh turn after retiring only a positively proven, non-ambiguous
 * orphan. The caller owns runtime-specific proof (no actor and no durable run);
 * this helper owns the exact load/CAS/retry sequence.
 */
export function captureDurableParentContinuationWithOrphanRecovery(input: Readonly<{
  store: DurableParentContinuationStoreV1
  capture: Readonly<{
    ownerId: string
    identity: DurableParentContinuationIdentityV1
  }>
  canRetireOrphan(record: DurableParentContinuationRecordV1): boolean
}>): DurableParentContinuationCaptureV1 {
  const initial = input.store.capture(input.capture)
  if (initial.kind !== 'busy') return initial

  const loaded = input.store.load()
  if (loaded.status !== 'ready' || loaded.record.phase !== 'active' ||
    loaded.record.ambiguity !== undefined ||
    loaded.record.continuationHash !== initial.continuationHash ||
    loaded.record.identity.sessionId !== initial.sessionId ||
    loaded.record.identity.turnId !== initial.turnId ||
    !input.canRetireOrphan(loaded.record)) return initial

  input.store.retire({
    continuationHash: loaded.record.continuationHash,
    ownerId: loaded.record.ownerId,
    expectedRevision: loaded.record.revision,
    terminalReceiptHash: orphanRetirementReceiptHash(loaded.record, input.capture.identity),
  })
  return input.store.capture(input.capture)
}

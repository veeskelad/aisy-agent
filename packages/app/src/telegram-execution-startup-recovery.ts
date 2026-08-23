import {
  confirmTelegramExecutionCheckpointDelivery,
  makeTelegramExecutionDeliveryReceipt,
  recoverTelegramExecutionCheckpoint,
  type TelegramExecutionCheckpointOutput,
  type TelegramExecutionCheckpointStore,
  type TelegramExecutionDeliveryReceiptV1,
  type TelegramExecutionRecoveryResult,
} from './telegram-execution-checkpoint.js'
import {
  assertExecutionSupervisorLeaseAuthority,
  isGenuineExecutionSupervisorRecoveryContextV1,
  type ExecutionSupervisorLeaseAuthorityViewV1,
} from './execution-supervisor-ipc.js'
import type {
  ExecutionStartupRecoveryContextV1,
  ExecutionStartupRecoveryPortV1,
  ExecutionStartupRecoveryStepResultV1,
} from './execution-startup-recovery-coordinator.js'

const HASH = /^[a-f0-9]{64}$/

export interface TelegramExecutionServiceManagerLease {
  /** Opaque authority captured before the original turn started. */
  readonly bindingHash: string
  readonly authorityPhase: 'captured-unbound' | 'checkpoint-bound'
  isHeld(): boolean
  bindCheckpoint(): Promise<void>
  release(): Promise<void>
  failClosed(): never
}

export interface TelegramExecutionServiceManagerPort {
  /** Returns null unless every competing runtime has been quiesced. */
  acquireRecoveryLease(): Promise<TelegramExecutionServiceManagerLease | null>
}

export interface TelegramExecutionAuthorityPublisher {
  /** Captures the opaque turn authority before checkpoint/provider work. */
  captureTurn(bindingHash: string): Promise<TelegramExecutionServiceManagerLease>
}

export type TelegramExecutionStartupRecoveryResult =
  | TelegramExecutionRecoveryResult
  | { kind: 'denied'; code: 'SERVICE_MANAGER_REQUIRED' | 'SERVICE_MANAGER_AUTHORITY_INVALID' }
  | { kind: 'incomplete'; code: 'QUIESCENCE_RELEASE_FAILED' | 'RECOVERY_FAILED' }

export interface TelegramExecutionDeliveryEvidenceV1 {
  readonly bindingHash: string
  readonly revision: number
  readonly delivery: 'delivered'
  readonly messageId: number
  readonly checkpointHash: string
}

export type TelegramExecutionHeldLeaseRecoveryResult =
  | Readonly<{ kind: 'none'; evidence: null }>
  | Readonly<{
      kind: 'recovered'
      delivery: 'already-delivered' | 'edited' | 'replacement-sent'
      messageId: number
      evidence: TelegramExecutionDeliveryEvidenceV1
    }>
  | Readonly<{
      kind: 'denied'
      code: 'SERVICE_MANAGER_AUTHORITY_INVALID' | 'QUIESCENCE_REQUIRED' | 'FOREIGN_BINDING'
      evidence: null
    }>
  | Readonly<{
      kind: 'quarantined'
      code: 'CHECKPOINT_QUARANTINED'
      evidence: null
    }>
  | Readonly<{
      kind: 'delivery-pending'
      code: 'TELEGRAM_DELIVERY_FAILED'
      evidence: null
    }>
  | Readonly<{
      kind: 'incomplete'
      code: 'RECOVERY_FAILED' | 'DELIVERY_EVIDENCE_UNAVAILABLE'
      evidence: null
    }>

type TelegramExecutionInternalRecoveryResult =
  | Exclude<TelegramExecutionHeldLeaseRecoveryResult, { kind: 'recovered' }>
  | Readonly<{
      kind: 'recovered'
      delivery: 'already-delivered' | 'edited' | 'replacement-sent'
      messageId: number
      evidence: TelegramExecutionDeliveryEvidenceV1 | null
    }>

function held(lease: TelegramExecutionServiceManagerLease): boolean {
  try { return lease.isHeld() === true } catch { return false }
}

function sameLeaseAuthority(
  first: ExecutionSupervisorLeaseAuthorityViewV1,
  current: ExecutionSupervisorLeaseAuthorityViewV1,
): boolean {
  return current.bindingHash === first.bindingHash && current.leaseId === first.leaseId &&
    current.authorityPhase === first.authorityPhase && current.sessionId === first.sessionId &&
    current.runLivenessHash === first.runLivenessHash
}

function checkpointEvidence(
  receipt: TelegramExecutionDeliveryReceiptV1,
): Readonly<TelegramExecutionDeliveryEvidenceV1> {
  return Object.freeze({
    bindingHash: receipt.bindingHash,
    revision: receipt.revision,
    delivery: receipt.delivery,
    messageId: receipt.messageId,
    checkpointHash: receipt.checkpointHash,
  })
}

async function recoverWithHeldLease(input: {
  store: TelegramExecutionCheckpointStore
  lease: TelegramExecutionServiceManagerLease
  output: TelegramExecutionCheckpointOutput
  newOwnerId: () => string
  nowIso?: () => string
  requireGenuine?: boolean
}): Promise<Readonly<{
  result: TelegramExecutionInternalRecoveryResult
  releaseAllowed: boolean
}>> {
  const wantsEvidence = input.requireGenuine === true
  let genuineAuthority: ExecutionSupervisorLeaseAuthorityViewV1 | null = null
  if (wantsEvidence) {
    try { genuineAuthority = assertExecutionSupervisorLeaseAuthority(input.lease) } catch {
      return Object.freeze({
        result: Object.freeze({
          kind: 'denied', code: 'SERVICE_MANAGER_AUTHORITY_INVALID', evidence: null,
        }),
        releaseAllowed: false,
      })
    }
  }
  let leaseBindingHash: string
  let authorityPhase: 'captured-unbound' | 'checkpoint-bound'
  try {
    leaseBindingHash = genuineAuthority?.bindingHash ?? input.lease.bindingHash
    authorityPhase = genuineAuthority?.authorityPhase ?? input.lease.authorityPhase
  } catch {
    leaseBindingHash = ''
    authorityPhase = 'checkpoint-bound'
  }
  if (!HASH.test(leaseBindingHash)) {
    return Object.freeze({
      result: Object.freeze({
        kind: 'denied', code: 'SERVICE_MANAGER_AUTHORITY_INVALID', evidence: null,
      }),
      releaseAllowed: false,
    })
  }
  const authorityHeld = (): boolean => {
    if (genuineAuthority === null) return held(input.lease)
    try {
      return sameLeaseAuthority(
        genuineAuthority,
        assertExecutionSupervisorLeaseAuthority(input.lease),
      )
    } catch {
      return false
    }
  }
  if (!authorityHeld()) {
    return Object.freeze({
      result: Object.freeze({ kind: 'denied', code: 'QUIESCENCE_REQUIRED', evidence: null }),
      releaseAllowed: false,
    })
  }

  const loaded = input.store.load()
  if (loaded.status === 'missing') {
    return Object.freeze({
      result: authorityPhase === 'captured-unbound'
        ? Object.freeze({ kind: 'none' as const, evidence: null })
        : Object.freeze({ kind: 'incomplete' as const, code: 'RECOVERY_FAILED' as const, evidence: null }),
      releaseAllowed: authorityPhase === 'captured-unbound',
    })
  }
  if (loaded.status === 'quarantined') {
    return Object.freeze({
      result: Object.freeze({ kind: 'quarantined', code: 'CHECKPOINT_QUARANTINED', evidence: null }),
      releaseAllowed: false,
    })
  }
  if (loaded.checkpoint.bindingHash !== leaseBindingHash) {
    return Object.freeze({
      result: Object.freeze({ kind: 'denied', code: 'FOREIGN_BINDING', evidence: null }),
      releaseAllowed: false,
    })
  }

  let delivery: 'already-delivered' | 'edited' | 'replacement-sent'
  let messageId: number
  if (loaded.checkpoint.phase === 'terminal' && loaded.checkpoint.delivery === 'delivered' &&
    loaded.checkpoint.messageId === undefined) {
    return Object.freeze({
      result: wantsEvidence
        ? Object.freeze({
            kind: 'incomplete' as const,
            code: 'DELIVERY_EVIDENCE_UNAVAILABLE' as const,
            evidence: null,
          })
        : Object.freeze({ kind: 'none' as const, evidence: null }),
      releaseAllowed: !wantsEvidence,
    })
  }
  if (loaded.checkpoint.phase === 'terminal' && loaded.checkpoint.delivery === 'delivered') {
    delivery = 'already-delivered'
    messageId = loaded.checkpoint.messageId!
  } else {
    let quiescenceLost = false
    const guard = (): void => {
      if (authorityHeld()) return
      quiescenceLost = true
      throw new Error('QUIESCENCE_REQUIRED')
    }
    const recovered = await recoverTelegramExecutionCheckpoint({
      store: input.store,
      bindingHash: leaseBindingHash,
      quiescence: { assertHeld: authorityHeld },
      output: {
        async sendText(html) {
          guard()
          return input.output.sendText(html)
        },
        async editText(currentMessageId, html) {
          guard()
          return input.output.editText(currentMessageId, html)
        },
      },
      newOwnerId: input.newOwnerId,
      ...(input.nowIso === undefined ? {} : { nowIso: input.nowIso }),
    })
    if (quiescenceLost && recovered.kind === 'delivery-pending') {
      return Object.freeze({
        result: Object.freeze({ kind: 'denied', code: 'QUIESCENCE_REQUIRED', evidence: null }),
        releaseAllowed: false,
      })
    }
    if (recovered.kind !== 'recovered') {
      return Object.freeze({
        result: Object.freeze({ ...recovered, evidence: null }) as TelegramExecutionInternalRecoveryResult,
        releaseAllowed: false,
      })
    }
    delivery = recovered.delivery
    messageId = recovered.messageId
  }

  if (!authorityHeld()) {
    return Object.freeze({
      result: Object.freeze({ kind: 'denied', code: 'QUIESCENCE_REQUIRED', evidence: null }),
      releaseAllowed: false,
    })
  }
  if (!wantsEvidence) {
    return Object.freeze({
      result: Object.freeze({
        kind: 'recovered', delivery, messageId,
        // The legacy wrapper predates envelope evidence and maps this result.
        evidence: null,
      }),
      releaseAllowed: true,
    })
  }
  const persisted = input.store.load()
  if (persisted.status !== 'ready' || persisted.checkpoint.bindingHash !== leaseBindingHash ||
    persisted.checkpoint.messageId !== messageId) {
    return Object.freeze({
      result: Object.freeze({ kind: 'incomplete', code: 'DELIVERY_EVIDENCE_UNAVAILABLE', evidence: null }),
      releaseAllowed: false,
    })
  }
  const candidate = makeTelegramExecutionDeliveryReceipt(persisted.checkpoint)
  if (candidate === null) {
    return Object.freeze({
      result: Object.freeze({ kind: 'incomplete', code: 'DELIVERY_EVIDENCE_UNAVAILABLE', evidence: null }),
      releaseAllowed: false,
    })
  }
  const confirmation = confirmTelegramExecutionCheckpointDelivery({
    store: input.store,
    bindingHash: leaseBindingHash,
    expectedReceipt: candidate,
  })
  const authorityStillHeld = authorityHeld()
  if (!authorityStillHeld || confirmation.kind !== 'delivered') {
    return Object.freeze({
      result: Object.freeze({
        kind: authorityStillHeld ? 'incomplete' : 'denied',
        code: authorityStillHeld ? 'DELIVERY_EVIDENCE_UNAVAILABLE' : 'QUIESCENCE_REQUIRED',
        evidence: null,
      }) as TelegramExecutionInternalRecoveryResult,
      releaseAllowed: false,
    })
  }
  return Object.freeze({
    result: Object.freeze({
      kind: 'recovered',
      delivery,
      messageId,
      evidence: checkpointEvidence(confirmation.receipt),
    }),
    releaseAllowed: true,
  })
}

/**
 * Coordinator-owned recovery. The caller retains the exact service-manager
 * lease; this seam never acquires, binds or releases it.
 */
export async function recoverTelegramExecutionWithHeldLease(input: {
  store: TelegramExecutionCheckpointStore
  lease: TelegramExecutionServiceManagerLease
  output: TelegramExecutionCheckpointOutput
  newOwnerId: () => string
  nowIso?: () => string
}): Promise<TelegramExecutionHeldLeaseRecoveryResult> {
  // Prove the exact manager-owned lease before evaluating store/output fields.
  let lease: TelegramExecutionServiceManagerLease
  try {
    lease = input.lease
    assertExecutionSupervisorLeaseAuthority(lease)
  } catch {
    return Object.freeze({
      kind: 'denied', code: 'SERVICE_MANAGER_AUTHORITY_INVALID', evidence: null,
    })
  }
  try {
    const result = (await recoverWithHeldLease({
      lease,
      store: input.store,
      output: input.output,
      newOwnerId: input.newOwnerId,
      ...(input.nowIso === undefined ? {} : { nowIso: input.nowIso }),
      requireGenuine: true,
    })).result
    return result.kind === 'recovered' && result.evidence === null
      ? Object.freeze({ kind: 'incomplete', code: 'DELIVERY_EVIDENCE_UNAVAILABLE', evidence: null })
      : result as TelegramExecutionHeldLeaseRecoveryResult
  } catch {
    return Object.freeze({ kind: 'incomplete', code: 'RECOVERY_FAILED', evidence: null })
  }
}

/**
 * Adapts Telegram recovery to the unified envelope without acquiring or
 * releasing its supervisor lease. The coordinator remains the sole releaser.
 */
export function makeTelegramExecutionStartupRecoveryPortV1(input: {
  store: TelegramExecutionCheckpointStore
  output: TelegramExecutionCheckpointOutput
  newOwnerId: () => string
  nowIso?: () => string
}): ExecutionStartupRecoveryPortV1 {
  return Object.freeze({
    async recover(
      context: ExecutionStartupRecoveryContextV1,
    ): Promise<ExecutionStartupRecoveryStepResultV1> {
      if (!isGenuineExecutionSupervisorRecoveryContextV1(context) ||
        context.schemaVersion !== 1 || !HASH.test(context.bindingHash) || !context.isHeld()) {
        return Object.freeze({ kind: 'denied', code: 'TELEGRAM_RECOVERY_AUTHORITY_INVALID' })
      }
      let loaded: ReturnType<TelegramExecutionCheckpointStore['load']>
      try { loaded = input.store.load() } catch {
        return Object.freeze({ kind: 'denied', code: 'TELEGRAM_RECOVERY_STATE_UNAVAILABLE' })
      }
      if (loaded.status === 'missing') {
        return context.authorityPhase === 'captured-unbound'
          ? Object.freeze({ kind: 'none' })
          : Object.freeze({ kind: 'denied', code: 'TELEGRAM_RECOVERY_STATE_MISSING' })
      }
      if (loaded.status === 'quarantined') {
        return Object.freeze({ kind: 'denied', code: 'TELEGRAM_RECOVERY_STATE_QUARANTINED' })
      }
      if (loaded.checkpoint.bindingHash !== context.bindingHash) {
        return Object.freeze({ kind: 'denied', code: 'TELEGRAM_RECOVERY_BINDING_MISMATCH' })
      }
      if (loaded.checkpoint.phase === 'terminal' && loaded.checkpoint.delivery === 'delivered') {
        return Object.freeze({ kind: 'terminal', bindingHash: context.bindingHash })
      }
      let recovered: TelegramExecutionRecoveryResult
      try {
        recovered = await recoverTelegramExecutionCheckpoint({
          store: input.store,
          bindingHash: context.bindingHash,
          quiescence: { assertHeld: () => context.isHeld() },
          output: input.output,
          newOwnerId: input.newOwnerId,
          ...(input.nowIso === undefined ? {} : { nowIso: input.nowIso }),
        })
      } catch {
        return Object.freeze({ kind: 'denied', code: 'TELEGRAM_RECOVERY_FAILED' })
      }
      return recovered.kind === 'recovered'
        ? Object.freeze({ kind: 'terminal', bindingHash: context.bindingHash })
        : Object.freeze({ kind: 'denied', code: 'TELEGRAM_RECOVERY_FAILED' })
    },
  })
}

/**
 * Offline startup seam. The service manager is the only source of both
 * quiescence and the opaque binding captured before the crashed turn. This
 * function never infers ownership from a PID, checkpoint age, or checkpoint
 * bytes and never exposes service-manager/Telegram errors.
 */
export async function recoverTelegramExecutionAtStartup(input: {
  store: TelegramExecutionCheckpointStore
  serviceManager: TelegramExecutionServiceManagerPort
  output: TelegramExecutionCheckpointOutput
  newOwnerId: () => string
  nowIso?: () => string
}): Promise<TelegramExecutionStartupRecoveryResult> {
  let lease: TelegramExecutionServiceManagerLease | null = null
  try { lease = await input.serviceManager.acquireRecoveryLease() } catch { /* code-only denial */ }
  if (lease === null) return { kind: 'denied', code: 'SERVICE_MANAGER_REQUIRED' }

  let result: TelegramExecutionStartupRecoveryResult
  let releaseFailed = false
  let releaseAllowed = false
  try {
    const recovered = await recoverWithHeldLease({
      store: input.store,
      lease,
      output: input.output,
      newOwnerId: input.newOwnerId,
      ...(input.nowIso === undefined ? {} : { nowIso: input.nowIso }),
    })
    releaseAllowed = recovered.releaseAllowed
    const heldResult = recovered.result
    if (heldResult.kind === 'recovered') {
      result = heldResult.delivery === 'already-delivered'
        ? { kind: 'none' }
        : { kind: 'recovered', delivery: heldResult.delivery, messageId: heldResult.messageId }
    } else if (heldResult.kind === 'incomplete' &&
      heldResult.code === 'DELIVERY_EVIDENCE_UNAVAILABLE') {
      result = { kind: 'incomplete', code: 'RECOVERY_FAILED' }
    } else {
      result = Object.fromEntries(Object.entries(heldResult).filter(([key]) => key !== 'evidence')) as
        TelegramExecutionStartupRecoveryResult
    }
  } catch {
    result = { kind: 'incomplete', code: 'RECOVERY_FAILED' }
  } finally {
    if (releaseAllowed) {
      try { await lease.release() } catch { releaseFailed = true }
    }
  }
  return releaseFailed
    ? { kind: 'incomplete', code: 'QUIESCENCE_RELEASE_FAILED' }
    : result
}

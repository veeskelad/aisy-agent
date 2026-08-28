import { createHmac, timingSafeEqual } from 'node:crypto'

import type { SwitchAuthorityNonceStore } from './switch-authority.js'

export interface SessionRotationAuthorityBinding {
  operatorId: string
  profileId: string
  projectId: string
  sourceSessionId: string
  newSessionId: string
  expectedGeneration: number
  localDate: string
  createKeyHash: string
}

export interface SessionRotationAuthorityReceipt extends SessionRotationAuthorityBinding {
  readonly purpose: 'aisy-session-rotation-v1'
  readonly receiptId: string
  readonly expiresAt: string
  readonly mac: string
}

export interface SessionRotationAuthority {
  issue(binding: SessionRotationAuthorityBinding, ttlMs: number): SessionRotationAuthorityReceipt
  consume(
    receipt: SessionRotationAuthorityReceipt,
    expected: SessionRotationAuthorityBinding,
  ): void
}

export class SessionRotationAuthorityError extends Error {
  constructor(public readonly code:
    | 'INVALID_AUTHORITY_SECRET'
    | 'INVALID_RECEIPT_INPUT'
    | 'RECEIPT_BINDING_MISMATCH'
    | 'RECEIPT_EXPIRED'
    | 'RECEIPT_MAC_INVALID'
    | 'REPLAYED_OR_UNKNOWN') {
    super(code)
    this.name = 'SessionRotationAuthorityError'
  }
}

const HASH = /^[a-f0-9]{64}$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/u

function clean(value: string): string {
  const result = value.trim()
  if (result.length === 0) throw new SessionRotationAuthorityError('INVALID_RECEIPT_INPUT')
  return result
}

function validateBinding(input: SessionRotationAuthorityBinding): SessionRotationAuthorityBinding {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1 ||
    !DATE.test(input.localDate) || !HASH.test(input.createKeyHash)) {
    throw new SessionRotationAuthorityError('INVALID_RECEIPT_INPUT')
  }
  return {
    operatorId: clean(input.operatorId),
    profileId: clean(input.profileId),
    projectId: clean(input.projectId),
    sourceSessionId: clean(input.sourceSessionId),
    newSessionId: clean(input.newSessionId),
    expectedGeneration: input.expectedGeneration,
    localDate: input.localDate,
    createKeyHash: input.createKeyHash,
  }
}

function payload(receipt: Omit<SessionRotationAuthorityReceipt, 'mac'>): string {
  return JSON.stringify([
    receipt.purpose,
    receipt.receiptId,
    receipt.operatorId,
    receipt.profileId,
    receipt.projectId,
    receipt.sourceSessionId,
    receipt.newSessionId,
    receipt.expectedGeneration,
    receipt.localDate,
    receipt.createKeyHash,
    receipt.expiresAt,
  ])
}

function sameBinding(
  receipt: SessionRotationAuthorityReceipt,
  expected: SessionRotationAuthorityBinding,
): boolean {
  return receipt.operatorId === expected.operatorId &&
    receipt.profileId === expected.profileId && receipt.projectId === expected.projectId &&
    receipt.sourceSessionId === expected.sourceSessionId &&
    receipt.newSessionId === expected.newSessionId &&
    receipt.expectedGeneration === expected.expectedGeneration &&
    receipt.localDate === expected.localDate && receipt.createKeyHash === expected.createKeyHash
}

export function makeSessionRotationAuthority(deps: {
  secret: Uint8Array
  nowMs: () => number
  newId: () => string
  nonces: SwitchAuthorityNonceStore
}): SessionRotationAuthority {
  if (deps.secret.byteLength < 32) {
    throw new SessionRotationAuthorityError('INVALID_AUTHORITY_SECRET')
  }
  const secret = Buffer.from(deps.secret)
  const sign = (unsigned: Omit<SessionRotationAuthorityReceipt, 'mac'>): string =>
    createHmac('sha256', secret).update(payload(unsigned)).digest('hex')

  return {
    issue(rawBinding, ttlMs) {
      const binding = validateBinding(rawBinding)
      const now = deps.nowMs()
      if (!Number.isFinite(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) {
        throw new SessionRotationAuthorityError('INVALID_RECEIPT_INPUT')
      }
      const unsigned: Omit<SessionRotationAuthorityReceipt, 'mac'> = {
        purpose: 'aisy-session-rotation-v1',
        receiptId: clean(deps.newId()),
        ...binding,
        expiresAt: new Date(now + ttlMs).toISOString(),
      }
      const receipt = { ...unsigned, mac: sign(unsigned) }
      deps.nonces.issue({ receiptId: receipt.receiptId, mac: receipt.mac, expiresAt: receipt.expiresAt })
      return receipt
    },

    consume(receipt, rawExpected) {
      const expected = validateBinding(rawExpected)
      if (receipt.purpose !== 'aisy-session-rotation-v1' || !sameBinding(receipt, expected)) {
        throw new SessionRotationAuthorityError('RECEIPT_BINDING_MISMATCH')
      }
      clean(receipt.receiptId)
      if (!HASH.test(receipt.mac)) {
        throw new SessionRotationAuthorityError('INVALID_RECEIPT_INPUT')
      }
      const expiresAt = Date.parse(receipt.expiresAt)
      const now = deps.nowMs()
      if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) {
        throw new SessionRotationAuthorityError('INVALID_RECEIPT_INPUT')
      }
      if (now >= expiresAt) throw new SessionRotationAuthorityError('RECEIPT_EXPIRED')
      const unsigned: Omit<SessionRotationAuthorityReceipt, 'mac'> = {
        purpose: receipt.purpose,
        receiptId: receipt.receiptId,
        operatorId: receipt.operatorId,
        profileId: receipt.profileId,
        projectId: receipt.projectId,
        sourceSessionId: receipt.sourceSessionId,
        newSessionId: receipt.newSessionId,
        expectedGeneration: receipt.expectedGeneration,
        localDate: receipt.localDate,
        createKeyHash: receipt.createKeyHash,
        expiresAt: receipt.expiresAt,
      }
      const expectedMac = Buffer.from(sign(unsigned), 'hex')
      const actualMac = Buffer.from(receipt.mac, 'hex')
      if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
        throw new SessionRotationAuthorityError('RECEIPT_MAC_INVALID')
      }
      if (!deps.nonces.consume(receipt.receiptId, receipt.mac)) {
        throw new SessionRotationAuthorityError('REPLAYED_OR_UNKNOWN')
      }
    },
  }
}

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SwitchAuthorityBinding {
  operatorId: string
  profileId: string
  targetProjectId: string
  targetSessionId?: string
  expectedGeneration: number
  sourceMessageHash: string
}

export interface SwitchAuthorityReceipt extends SwitchAuthorityBinding {
  receiptId: string
  expiresAt: string
  mac: string
}

export interface SwitchAuthorityNonceRecord {
  receiptId: string
  mac: string
  expiresAt: string
}

export interface SwitchAuthorityNonceStore {
  issue(record: SwitchAuthorityNonceRecord): void
  has(receiptId: string, mac: string): boolean
  consume(receiptId: string, mac: string): boolean
}

export interface SwitchAuthority {
  issue(binding: SwitchAuthorityBinding, ttlMs: number): SwitchAuthorityReceipt
  validate(receipt: SwitchAuthorityReceipt, expected: SwitchAuthorityBinding): void
  isIssued(receipt: SwitchAuthorityReceipt): boolean
  markConsumed(receipt: SwitchAuthorityReceipt): boolean
  consume(receipt: SwitchAuthorityReceipt, expected: SwitchAuthorityBinding): void
}

export class SwitchAuthorityError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_AUTHORITY_SECRET'
      | 'INVALID_RECEIPT_INPUT'
      | 'RECEIPT_BINDING_MISMATCH'
      | 'RECEIPT_EXPIRED'
      | 'RECEIPT_MAC_INVALID'
      | 'REPLAYED_OR_UNKNOWN',
  ) {
    super(code)
    this.name = 'SwitchAuthorityError'
  }
}

const HASH = /^[a-f0-9]{64}$/

function clean(value: string): string {
  const result = value.trim()
  if (result.length === 0) throw new SwitchAuthorityError('INVALID_RECEIPT_INPUT')
  return result
}

function validateBinding(input: SwitchAuthorityBinding): SwitchAuthorityBinding {
  if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1 ||
    !HASH.test(input.sourceMessageHash)) {
    throw new SwitchAuthorityError('INVALID_RECEIPT_INPUT')
  }
  return {
    operatorId: clean(input.operatorId),
    profileId: clean(input.profileId),
    targetProjectId: clean(input.targetProjectId),
    ...(input.targetSessionId === undefined ? {} : { targetSessionId: clean(input.targetSessionId) }),
    expectedGeneration: input.expectedGeneration,
    sourceMessageHash: input.sourceMessageHash,
  }
}

function payload(receipt: Omit<SwitchAuthorityReceipt, 'mac'>): string {
  return JSON.stringify([
    'aisy-switch-authority-v1',
    receipt.receiptId,
    receipt.operatorId,
    receipt.profileId,
    receipt.targetProjectId,
    receipt.targetSessionId ?? null,
    receipt.expectedGeneration,
    receipt.sourceMessageHash,
    receipt.expiresAt,
  ])
}

function sameBinding(receipt: SwitchAuthorityReceipt, expected: SwitchAuthorityBinding): boolean {
  return receipt.operatorId === expected.operatorId &&
    receipt.profileId === expected.profileId &&
    receipt.targetProjectId === expected.targetProjectId &&
    receipt.targetSessionId === expected.targetSessionId &&
    receipt.expectedGeneration === expected.expectedGeneration &&
    receipt.sourceMessageHash === expected.sourceMessageHash
}

export function makeSwitchAuthority(deps: {
  secret: Uint8Array
  nowMs: () => number
  newId: () => string
  nonces: SwitchAuthorityNonceStore
}): SwitchAuthority {
  if (deps.secret.byteLength < 32) throw new SwitchAuthorityError('INVALID_AUTHORITY_SECRET')
  const secret = Buffer.from(deps.secret)
  const sign = (unsigned: Omit<SwitchAuthorityReceipt, 'mac'>): string =>
    createHmac('sha256', secret).update(payload(unsigned)).digest('hex')
  const validateReceipt = (
    receipt: SwitchAuthorityReceipt,
    rawExpected: SwitchAuthorityBinding,
  ): void => {
    const expected = validateBinding(rawExpected)
    if (!sameBinding(receipt, expected)) {
      throw new SwitchAuthorityError('RECEIPT_BINDING_MISMATCH')
    }
    clean(receipt.receiptId)
    if (!HASH.test(receipt.mac)) throw new SwitchAuthorityError('INVALID_RECEIPT_INPUT')
    const expiresAt = Date.parse(receipt.expiresAt)
    const now = deps.nowMs()
    if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) {
      throw new SwitchAuthorityError('INVALID_RECEIPT_INPUT')
    }
    if (now >= expiresAt) throw new SwitchAuthorityError('RECEIPT_EXPIRED')

    const unsigned: Omit<SwitchAuthorityReceipt, 'mac'> = {
      receiptId: receipt.receiptId,
      operatorId: receipt.operatorId,
      profileId: receipt.profileId,
      targetProjectId: receipt.targetProjectId,
      ...(receipt.targetSessionId === undefined ? {} : { targetSessionId: receipt.targetSessionId }),
      expectedGeneration: receipt.expectedGeneration,
      sourceMessageHash: receipt.sourceMessageHash,
      expiresAt: receipt.expiresAt,
    }
    const expectedMac = Buffer.from(sign(unsigned), 'hex')
    const actualMac = Buffer.from(receipt.mac, 'hex')
    if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
      throw new SwitchAuthorityError('RECEIPT_MAC_INVALID')
    }
  }

  return {
    issue(rawBinding, ttlMs) {
      const binding = validateBinding(rawBinding)
      const now = deps.nowMs()
      if (!Number.isFinite(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) {
        throw new SwitchAuthorityError('INVALID_RECEIPT_INPUT')
      }
      const receiptId = clean(deps.newId())
      const unsigned: Omit<SwitchAuthorityReceipt, 'mac'> = {
        receiptId,
        ...binding,
        expiresAt: new Date(now + ttlMs).toISOString(),
      }
      const receipt: SwitchAuthorityReceipt = { ...unsigned, mac: sign(unsigned) }
      deps.nonces.issue({ receiptId, mac: receipt.mac, expiresAt: receipt.expiresAt })
      return { ...receipt }
    },

    validate(receipt, rawExpected) {
      validateReceipt(receipt, rawExpected)
    },

    isIssued(receipt) {
      return deps.nonces.has(receipt.receiptId, receipt.mac)
    },

    markConsumed(receipt) {
      return deps.nonces.consume(receipt.receiptId, receipt.mac)
    },

    consume(receipt, expected) {
      validateReceipt(receipt, expected)
      if (!deps.nonces.consume(receipt.receiptId, receipt.mac)) {
        throw new SwitchAuthorityError('REPLAYED_OR_UNKNOWN')
      }
    },
  }
}

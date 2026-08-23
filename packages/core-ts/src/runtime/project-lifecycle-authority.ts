import { createHmac, timingSafeEqual } from 'node:crypto'

import type {
  ProjectLifecycleAuthority,
  ProjectLifecycleAuthorityBinding,
  ProjectLifecycleAuthorityReceipt,
} from './project-service.js'

export interface ProjectLifecycleAuthorityNonceRecord {
  receiptId: string
  mac: string
  expiresAt: string
}

export interface ProjectLifecycleAuthorityNonceStore {
  issue(record: ProjectLifecycleAuthorityNonceRecord): void
  consume(receiptId: string, mac: string): boolean
}

export interface ProjectLifecycleAuthorityIssuer extends ProjectLifecycleAuthority {
  issue(
    binding: ProjectLifecycleAuthorityBinding,
    ttlMs: number,
  ): ProjectLifecycleAuthorityReceipt
}

export class ProjectLifecycleAuthorityError extends Error {
  constructor(public readonly code:
    | 'INVALID_AUTHORITY_SECRET'
    | 'INVALID_RECEIPT_INPUT'
    | 'RECEIPT_BINDING_MISMATCH'
    | 'RECEIPT_EXPIRED'
    | 'RECEIPT_MAC_INVALID'
    | 'REPLAYED_OR_UNKNOWN',
  ) {
    super(code)
    this.name = 'ProjectLifecycleAuthorityError'
  }
}

const PURPOSE = 'aisy-project-lifecycle-v1' as const
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_DATE_MS = 8_640_000_000_000_000
const RECEIPT_KEYS = new Set([
  'purpose',
  'receiptId',
  'operatorId',
  'profileId',
  'action',
  'projectId',
  'expectedGeneration',
  'sourceMessageHash',
  'expiresAt',
  'mac',
])
const SESSION_RECEIPT_KEYS = new Set([...RECEIPT_KEYS, 'sessionId'])
const BINDING_KEYS = new Set([
  'operatorId',
  'profileId',
  'action',
  'projectId',
  'expectedGeneration',
  'sourceMessageHash',
])
const SESSION_BINDING_KEYS = new Set([...BINDING_KEYS, 'sessionId'])

function clean(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || value !== value.trim() ||
    value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProjectLifecycleAuthorityError('INVALID_RECEIPT_INPUT')
  }
  return value
}

function validateBinding(input: ProjectLifecycleAuthorityBinding): ProjectLifecycleAuthorityBinding {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProjectLifecycleAuthorityError('INVALID_RECEIPT_INPUT')
  }
  const keys = Object.keys(input)
  const expectedKeys = input.sessionId === undefined ? BINDING_KEYS : SESSION_BINDING_KEYS
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key)) ||
    (input.action !== 'project.archive' && input.action !== 'session.archive') ||
    !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1 ||
    typeof input.sourceMessageHash !== 'string' || !HASH.test(input.sourceMessageHash) ||
    (input.action === 'project.archive' && input.sessionId !== undefined) ||
    (input.action === 'session.archive' && input.sessionId === undefined)) {
    throw new ProjectLifecycleAuthorityError('INVALID_RECEIPT_INPUT')
  }
  return {
    operatorId: clean(input.operatorId),
    profileId: clean(input.profileId),
    action: input.action,
    projectId: clean(input.projectId),
    ...(input.sessionId === undefined ? {} : { sessionId: clean(input.sessionId) }),
    expectedGeneration: input.expectedGeneration,
    sourceMessageHash: input.sourceMessageHash,
  }
}

function validateReceiptShape(input: ProjectLifecycleAuthorityReceipt): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProjectLifecycleAuthorityError('INVALID_RECEIPT_INPUT')
  }
  const keys = Object.keys(input)
  const expectedKeys = input.sessionId === undefined ? RECEIPT_KEYS : SESSION_RECEIPT_KEYS
  if (keys.length !== expectedKeys.size || keys.some((key) => !expectedKeys.has(key)) ||
    input.purpose !== PURPOSE || typeof input.receiptId !== 'string' || !ID.test(input.receiptId) ||
    typeof input.mac !== 'string' || !HASH.test(input.mac) ||
    typeof input.expiresAt !== 'string' || input.expiresAt.length > 64) {
    throw new ProjectLifecycleAuthorityError('INVALID_RECEIPT_INPUT')
  }
}

function payload(receipt: Omit<ProjectLifecycleAuthorityReceipt, 'mac'>): string {
  return JSON.stringify([
    PURPOSE,
    receipt.receiptId,
    receipt.operatorId,
    receipt.profileId,
    receipt.action,
    receipt.projectId,
    receipt.sessionId ?? null,
    receipt.expectedGeneration,
    receipt.sourceMessageHash,
    receipt.expiresAt,
  ])
}

function sameBinding(
  receipt: ProjectLifecycleAuthorityReceipt,
  expected: ProjectLifecycleAuthorityBinding,
): boolean {
  return receipt.operatorId === expected.operatorId &&
    receipt.profileId === expected.profileId &&
    receipt.action === expected.action &&
    receipt.projectId === expected.projectId &&
    receipt.sessionId === expected.sessionId &&
    receipt.expectedGeneration === expected.expectedGeneration &&
    receipt.sourceMessageHash === expected.sourceMessageHash
}

export function makeProjectLifecycleAuthority(input: {
  secret: Uint8Array
  nowMs: () => number
  newId: () => string
  nonces: ProjectLifecycleAuthorityNonceStore
}): ProjectLifecycleAuthorityIssuer {
  if (input.secret.byteLength < 32) {
    throw new ProjectLifecycleAuthorityError('INVALID_AUTHORITY_SECRET')
  }
  const secret = Buffer.from(input.secret)
  const sign = (unsigned: Omit<ProjectLifecycleAuthorityReceipt, 'mac'>): string =>
    createHmac('sha256', secret).update(payload(unsigned)).digest('hex')

  return Object.freeze({
    issue(rawBinding: ProjectLifecycleAuthorityBinding, ttlMs: number) {
      const binding = validateBinding(rawBinding)
      const now = input.nowMs()
      if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000 ||
        now + ttlMs > MAX_DATE_MS) {
        throw new ProjectLifecycleAuthorityError('INVALID_RECEIPT_INPUT')
      }
      const receiptId = input.newId()
      if (typeof receiptId !== 'string' || !ID.test(receiptId)) {
        throw new ProjectLifecycleAuthorityError('INVALID_RECEIPT_INPUT')
      }
      const unsigned: Omit<ProjectLifecycleAuthorityReceipt, 'mac'> = {
        purpose: PURPOSE,
        receiptId,
        ...binding,
        expiresAt: new Date(now + ttlMs).toISOString(),
      }
      const receipt: ProjectLifecycleAuthorityReceipt = { ...unsigned, mac: sign(unsigned) }
      input.nonces.issue({ receiptId, mac: receipt.mac, expiresAt: receipt.expiresAt })
      return Object.freeze({ ...receipt })
    },

    consume(
      receipt: ProjectLifecycleAuthorityReceipt,
      rawExpected: ProjectLifecycleAuthorityBinding,
    ) {
      validateReceiptShape(receipt)
      const expected = validateBinding(rawExpected)
      if (!sameBinding(receipt, expected)) {
        throw new ProjectLifecycleAuthorityError('RECEIPT_BINDING_MISMATCH')
      }
      const expiresAt = Date.parse(receipt.expiresAt)
      const now = input.nowMs()
      if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS ||
        !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== receipt.expiresAt) {
        throw new ProjectLifecycleAuthorityError('INVALID_RECEIPT_INPUT')
      }
      if (now >= expiresAt) throw new ProjectLifecycleAuthorityError('RECEIPT_EXPIRED')
      if (expiresAt - now > 300_000) {
        throw new ProjectLifecycleAuthorityError('INVALID_RECEIPT_INPUT')
      }

      const unsigned: Omit<ProjectLifecycleAuthorityReceipt, 'mac'> = {
        purpose: PURPOSE,
        receiptId: receipt.receiptId,
        operatorId: receipt.operatorId,
        profileId: receipt.profileId,
        action: receipt.action,
        projectId: receipt.projectId,
        ...(receipt.sessionId === undefined ? {} : { sessionId: receipt.sessionId }),
        expectedGeneration: receipt.expectedGeneration,
        sourceMessageHash: receipt.sourceMessageHash,
        expiresAt: receipt.expiresAt,
      }
      const expectedMac = Buffer.from(sign(unsigned), 'hex')
      const actualMac = Buffer.from(receipt.mac, 'hex')
      if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
        throw new ProjectLifecycleAuthorityError('RECEIPT_MAC_INVALID')
      }
      if (!input.nonces.consume(receipt.receiptId, receipt.mac)) {
        throw new ProjectLifecycleAuthorityError('REPLAYED_OR_UNKNOWN')
      }
    },
  })
}

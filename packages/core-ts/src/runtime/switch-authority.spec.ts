import { describe, expect, it } from 'vitest'
import {
  makeSwitchAuthority,
  SwitchAuthorityError,
  type SwitchAuthorityNonceRecord,
} from './switch-authority.js'

function setup() {
  const nonces = new Map<string, SwitchAuthorityNonceRecord>()
  let nowMs = Date.parse('2026-07-26T21:00:00.000Z')
  let id = 0
  let consumeCalls = 0
  const authority = makeSwitchAuthority({
    secret: Buffer.alloc(32, 7),
    nowMs: () => nowMs,
    newId: () => `receipt-${++id}`,
    nonces: {
      issue: (record) => { nonces.set(record.receiptId, { ...record }) },
      has: (receiptId, mac) => nonces.get(receiptId)?.mac === mac,
      consume: (receiptId, mac) => {
        consumeCalls++
        const record = nonces.get(receiptId)
        if (!record || record.mac !== mac) return false
        nonces.delete(receiptId)
        return true
      },
    },
  })
  const request = {
    operatorId: 'telegram:42',
    profileId: 'default',
    targetProjectId: 'project-b',
    targetSessionId: 'session-b',
    expectedGeneration: 3,
    sourceMessageHash: 'a'.repeat(64),
  }
  return {
    authority,
    request,
    nonces,
    consumeCalls: () => consumeCalls,
    advance: (ms: number) => { nowMs += ms },
  }
}

describe('SwitchAuthorityReceipt', () => {
  it('issues an opaque short-lived receipt bound to the complete switch intent', () => {
    const { authority, request, nonces } = setup()

    const receipt = authority.issue(request, 30_000)

    expect(receipt).toMatchObject({
      receiptId: 'receipt-1',
      ...request,
      expiresAt: '2026-07-26T21:00:30.000Z',
    })
    expect(receipt.mac).toMatch(/^[a-f0-9]{64}$/)
    expect(nonces.get('receipt-1')).toEqual({
      receiptId: 'receipt-1',
      mac: receipt.mac,
      expiresAt: receipt.expiresAt,
    })
  })

  it('consumes a valid receipt exactly once', () => {
    const { authority, request } = setup()
    const receipt = authority.issue(request, 30_000)

    expect(authority.consume(receipt, request)).toBeUndefined()
    expect(() => authority.consume(receipt, request)).toThrowError(
      expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }),
    )
  })

  it.each([
    ['operatorId', 'telegram:99'],
    ['profileId', 'foreign'],
    ['targetProjectId', 'project-c'],
    ['targetSessionId', 'session-c'],
    ['expectedGeneration', 4],
    ['sourceMessageHash', 'b'.repeat(64)],
  ] as const)('rejects wrong %s before consuming the nonce', (field, value) => {
    const { authority, request, consumeCalls } = setup()
    const receipt = authority.issue(request, 30_000)

    expect(() => authority.consume(receipt, { ...request, [field]: value })).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_BINDING_MISMATCH' }),
    )
    expect(consumeCalls()).toBe(0)
  })

  it('rejects expired and MAC-tampered receipts before nonce consumption', () => {
    const { authority, request, advance, consumeCalls } = setup()
    const expired = authority.issue(request, 1_000)
    advance(1_001)
    expect(() => authority.consume(expired, request)).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_EXPIRED' }),
    )

    const valid = authority.issue(request, 30_000)
    expect(() => authority.consume({ ...valid, mac: '0'.repeat(64) }, request)).toThrow(
      SwitchAuthorityError,
    )
    expect(consumeCalls()).toBe(0)
  })

  it('rejects weak secrets and invalid source hashes at construction/issue time', () => {
    expect(() => makeSwitchAuthority({
      secret: Buffer.alloc(8),
      nowMs: () => 0,
      newId: () => 'id',
      nonces: { issue: () => {}, has: () => true, consume: () => true },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_AUTHORITY_SECRET' }))

    const { authority, request } = setup()
    expect(() => authority.issue({ ...request, sourceMessageHash: 'raw text' }, 30_000)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECEIPT_INPUT' }),
    )
  })
})

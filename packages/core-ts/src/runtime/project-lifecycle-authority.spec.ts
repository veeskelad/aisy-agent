import { describe, expect, it } from 'vitest'

import {
  makeProjectLifecycleAuthority,
  ProjectLifecycleAuthorityError,
  type ProjectLifecycleAuthorityNonceRecord,
} from './project-lifecycle-authority.js'
import { makeSwitchAuthority, type SwitchAuthorityNonceRecord } from './switch-authority.js'

const NOW = Date.parse('2026-07-28T12:00:00.000Z')
const SOURCE_HASH = 'a'.repeat(64)

function setup() {
  const nonces = new Map<string, ProjectLifecycleAuthorityNonceRecord>()
  let nowMs = NOW
  let consumeCalls = 0
  const authority = makeProjectLifecycleAuthority({
    secret: Buffer.alloc(32, 9),
    nowMs: () => nowMs,
    newId: () => 'lifecycle-1',
    nonces: {
      issue: (record) => { nonces.set(record.receiptId, { ...record }) },
      consume: (receiptId, mac) => {
        consumeCalls++
        const record = nonces.get(receiptId)
        if (record?.mac !== mac) return false
        nonces.delete(receiptId)
        return true
      },
    },
  })
  const binding = {
    operatorId: 'telegram:42',
    profileId: 'default',
    action: 'session.archive' as const,
    projectId: 'project-a',
    sessionId: 'session-a',
    expectedGeneration: 3,
    sourceMessageHash: SOURCE_HASH,
  }
  return {
    authority,
    binding,
    nonces,
    consumeCalls: () => consumeCalls,
    advance: (ms: number) => { nowMs += ms },
  }
}

describe('ProjectLifecycleAuthority', () => {
  it('issues and consumes one exact purpose-bound archive receipt once', () => {
    const { authority, binding, nonces } = setup()
    const receipt = authority.issue(binding, 30_000)

    expect(receipt).toMatchObject({
      purpose: 'aisy-project-lifecycle-v1',
      receiptId: 'lifecycle-1',
      ...binding,
      expiresAt: '2026-07-28T12:00:30.000Z',
    })
    expect(receipt.mac).toMatch(/^[a-f0-9]{64}$/)
    expect(nonces.get(receipt.receiptId)?.mac).toBe(receipt.mac)
    expect(authority.consume(receipt, binding)).toBeUndefined()
    expect(() => authority.consume(receipt, binding)).toThrowError(
      expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }),
    )
  })

  it.each([
    ['operatorId', 'telegram:99'],
    ['profileId', 'foreign'],
    ['projectId', 'project-b'],
    ['sessionId', 'session-b'],
    ['expectedGeneration', 4],
    ['sourceMessageHash', 'b'.repeat(64)],
  ] as const)('rejects wrong %s without spending the nonce', (field, value) => {
    const { authority, binding, consumeCalls } = setup()
    const receipt = authority.issue(binding, 30_000)

    expect(() => authority.consume(receipt, { ...binding, [field]: value })).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_BINDING_MISMATCH' }),
    )
    expect(consumeCalls()).toBe(0)
  })

  it('rejects a different valid lifecycle action without spending the nonce', () => {
    const { authority, binding, consumeCalls } = setup()
    const receipt = authority.issue(binding, 30_000)

    expect(() => authority.consume(receipt, {
      operatorId: binding.operatorId,
      profileId: binding.profileId,
      action: 'project.archive',
      projectId: binding.projectId,
      expectedGeneration: binding.expectedGeneration,
      sourceMessageHash: binding.sourceMessageHash,
    })).toThrowError(expect.objectContaining({ code: 'RECEIPT_BINDING_MISMATCH' }))
    expect(consumeCalls()).toBe(0)
  })

  it('rejects expiry, tampering, extra carrier fields, and invalid action/session shapes', () => {
    const { authority, binding, advance, consumeCalls } = setup()
    const receipt = authority.issue(binding, 1_000)
    advance(1_001)
    expect(() => authority.consume(receipt, binding)).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_EXPIRED' }),
    )

    const fresh = setup()
    const valid = fresh.authority.issue(fresh.binding, 30_000)
    expect(() => fresh.authority.consume({ ...valid, mac: '0'.repeat(64) }, fresh.binding))
      .toThrow(ProjectLifecycleAuthorityError)
    expect(() => fresh.authority.consume({ ...valid, extra: true } as never, fresh.binding))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT_INPUT' }))
    expect(() => fresh.authority.consume({ ...valid, receiptId: 42 } as never, fresh.binding))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT_INPUT' }))
    expect(() => fresh.authority.issue({
      ...fresh.binding,
      action: 'project.archive',
    }, 30_000)).toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT_INPUT' }))
    expect(() => fresh.authority.issue({ ...fresh.binding, extra: true } as never, 30_000))
      .toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT_INPUT' }))
    expect(consumeCalls()).toBe(0)
  })

  it('does not accept a SwitchAuthorityReceipt even when ids and secrets coincide', () => {
    const { authority, binding } = setup()
    const switchNonces = new Map<string, SwitchAuthorityNonceRecord>()
    const switchAuthority = makeSwitchAuthority({
      secret: Buffer.alloc(32, 9),
      nowMs: () => NOW,
      newId: () => 'lifecycle-1',
      nonces: {
        issue: (record) => { switchNonces.set(record.receiptId, record) },
        has: () => true,
        consume: () => true,
      },
    })
    const switchReceipt = switchAuthority.issue({
      operatorId: binding.operatorId,
      profileId: binding.profileId,
      targetProjectId: binding.projectId,
      targetSessionId: binding.sessionId,
      expectedGeneration: binding.expectedGeneration,
      sourceMessageHash: binding.sourceMessageHash,
    }, 30_000)

    expect(() => authority.consume(switchReceipt as never, binding)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECEIPT_INPUT' }),
    )
  })
})

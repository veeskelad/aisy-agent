import { describe, expect, it } from 'vitest'

import {
  makeSessionRotationAuthority,
  type SessionRotationAuthorityBinding,
} from './session-rotation-authority.js'
import type { SwitchAuthorityNonceRecord } from './switch-authority.js'

const BINDING: SessionRotationAuthorityBinding = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sourceSessionId: 'session-old',
  newSessionId: 'session-new',
  expectedGeneration: 7,
  localDate: '2026-08-28',
  createKeyHash: 'a'.repeat(64),
}

function setup() {
  const nonces = new Map<string, SwitchAuthorityNonceRecord>()
  let now = Date.parse('2026-08-28T03:30:00.000Z')
  const authority = makeSessionRotationAuthority({
    secret: Buffer.alloc(32, 8),
    nowMs: () => now,
    newId: () => 'rotation-receipt-1',
    nonces: {
      issue: record => { nonces.set(record.receiptId, record) },
      has: (id, mac) => nonces.get(id)?.mac === mac,
      consume: (id, mac) => {
        if (nonces.get(id)?.mac !== mac) return false
        nonces.delete(id)
        return true
      },
    },
  })
  return { authority, advance: (ms: number) => { now += ms } }
}

describe('SessionRotationAuthority', () => {
  it('is purpose-bound to the exact daily rotation and one-use', () => {
    const { authority } = setup()
    const receipt = authority.issue(BINDING, 30_000)

    expect(receipt).toMatchObject({ purpose: 'aisy-session-rotation-v1', ...BINDING })
    expect(() => authority.consume(receipt, { ...BINDING, localDate: '2026-08-29' }))
      .toThrowError(expect.objectContaining({ code: 'RECEIPT_BINDING_MISMATCH' }))
    expect(authority.consume(receipt, BINDING)).toBeUndefined()
    expect(() => authority.consume(receipt, BINDING))
      .toThrowError(expect.objectContaining({ code: 'REPLAYED_OR_UNKNOWN' }))
  })

  it('rejects an expired receipt without accepting it as an interactive switch receipt', () => {
    const { authority, advance } = setup()
    const receipt = authority.issue(BINDING, 1_000)
    advance(1_001)

    expect(() => authority.consume(receipt, BINDING))
      .toThrowError(expect.objectContaining({ code: 'RECEIPT_EXPIRED' }))
    expect(receipt).not.toHaveProperty('targetProjectId')
    expect(receipt).not.toHaveProperty('sourceMessageHash')
  })
})

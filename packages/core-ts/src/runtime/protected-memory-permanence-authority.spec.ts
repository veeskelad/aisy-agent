import { describe, expect, it, vi } from 'vitest'
import type { PendingAction } from '../gateway/index.js'
import type { ApprovalDecision } from './hook-gate.js'
import {
  makeMemoryPermanenceAuthority,
  MemoryPermanenceAuthorityError,
  type MemoryPermanenceAuditEvent,
  type MemoryPermanenceAuthorizationRequest,
  type MemoryPermanenceNonceRecord,
} from './protected-memory-permanence-authority.js'

const NOW = Date.parse('2026-07-27T12:00:00.000Z')
const CONFIRMED_AT = new Date(NOW - 1_000).toISOString()

function request(
  overrides: Partial<MemoryPermanenceAuthorizationRequest> = {},
): MemoryPermanenceAuthorizationRequest {
  return {
    lease: {
      operatorId: 'telegram:42',
      profileId: 'default',
      projectId: 'project-a',
      projectKind: 'project',
      sessionId: 'session-a',
      root: '/safe/project-a',
      generation: 3,
      leaseId: 'lease-a',
    },
    scope: { kind: 'project', scopeId: 'project:project-a', projectId: 'project-a' },
    factId: 'fact-a',
    targetOperationId: 'a'.repeat(64),
    factKey: 'b'.repeat(64),
    sourcePath: `memory/facts/${'c'.repeat(64)}.md`,
    contentHash: 'd'.repeat(64),
    reason: 'Запрос оператора',
    ...overrides,
  }
}

function harness(input: {
  decision?: (action: PendingAction) => ApprovalDecision | Promise<ApprovalDecision>
  nowMs?: () => number
  consume?: boolean
  auditError?: Error
} = {}) {
  const calls: string[] = []
  const issued: MemoryPermanenceNonceRecord[] = []
  const audits: MemoryPermanenceAuditEvent[] = []
  let captured: PendingAction | undefined
  const authority = makeMemoryPermanenceAuthority({
    secret: Buffer.alloc(32, 7),
    nowMs: input.nowMs ?? (() => NOW),
    newActionId: () => 'action-a',
    newReceiptId: () => 'receipt-a',
    nonces: {
      issue(record) {
        calls.push('issue')
        issued.push(structuredClone(record))
      },
      consume(receiptId, mac) {
        calls.push('consume')
        return (input.consume ?? true) && issued.some(
          (record) => record.receiptId === receiptId && record.mac === mac,
        )
      },
    },
    async approve(_lease, action) {
      calls.push('approve')
      captured = structuredClone(action)
      return await (input.decision?.(action) ?? {
        decision: 'confirmed' as const,
        proof: {
          cardId: 'card-a',
          actionId: action.actionId,
          actionHash: action.actionHash,
          confirmedAt: CONFIRMED_AT,
          stepUpVerified: true,
        },
      })
    },
    async deliverAuditOnce(event) {
      calls.push('audit')
      if (input.auditError) throw input.auditError
      audits.push(structuredClone(event))
    },
  })
  return { authority, audits, calls, captured: () => captured, issued }
}

describe('MemoryPermanenceAuthority', () => {
  it('mints a Tier-3 card bound to the exact target and returns an audited one-use receipt', async () => {
    const h = harness()

    const receipt = await h.authority.authorize(request())

    expect(h.captured()).toMatchObject({
      actionId: 'action-a',
      actionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      tier: 3,
      requiresStepUp: true,
    })
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      receiptId: 'receipt-a',
      actionId: 'action-a',
      cardId: 'card-a',
      actionHash: h.captured()?.actionHash,
      operatorId: 'telegram:42',
      profileId: 'default',
      sessionId: 'session-a',
      generation: 3,
      scope: { kind: 'project', scopeId: 'project:project-a', projectId: 'project-a' },
      factId: 'fact-a',
      targetOperationId: 'a'.repeat(64),
      factKey: 'b'.repeat(64),
      sourcePath: `memory/facts/${'c'.repeat(64)}.md`,
      contentHash: 'd'.repeat(64),
      reasonHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      confirmedAt: CONFIRMED_AT,
      consumedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
      stepUpVerified: true,
      mac: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(h.calls).toEqual(['approve', 'issue', 'consume', 'audit'])
    expect(h.audits).toEqual([expect.objectContaining({
      eventId: 'receipt-a',
      kind: 'memory.permanence.authorized',
      mac: receipt?.mac,
    })])
  })

  it('changes the action hash when any deletion target identity changes', async () => {
    const hashes: string[] = []
    for (const candidate of [
      request(),
      request({ contentHash: 'e'.repeat(64) }),
      request({ factKey: 'f'.repeat(64) }),
      request({ targetOperationId: '9'.repeat(64) }),
      request({ reason: 'Другая причина' }),
    ]) {
      const h = harness({ decision: (action) => {
        hashes.push(action.actionHash)
        return { decision: 'rejected' }
      } })
      await expect(h.authority.authorize(candidate)).resolves.toBeNull()
    }
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('does not mint a receipt or audit when the operator rejects the card', async () => {
    const h = harness({ decision: () => ({ decision: 'rejected' }) })
    await expect(h.authority.authorize(request())).resolves.toBeNull()
    expect(h.calls).toEqual(['approve'])
    expect(h.issued).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('requires code-minted proof and exact action, card, step-up, and timestamp fields', async () => {
    const cases: Array<[string, (action: PendingAction) => ApprovalDecision, string]> = [
      ['missing proof', () => ({ decision: 'confirmed' }), 'APPROVAL_PROOF_REQUIRED'],
      ['wrong action id', (action) => ({ decision: 'confirmed', proof: {
        cardId: 'card-a', actionId: 'other', actionHash: action.actionHash,
        confirmedAt: CONFIRMED_AT, stepUpVerified: true,
      } }), 'APPROVAL_PROOF_MISMATCH'],
      ['wrong action hash', (action) => ({ decision: 'confirmed', proof: {
        cardId: 'card-a', actionId: action.actionId, actionHash: '0'.repeat(64),
        confirmedAt: CONFIRMED_AT, stepUpVerified: true,
      } }), 'APPROVAL_PROOF_MISMATCH'],
      ['no step-up', (action) => ({ decision: 'confirmed', proof: {
        cardId: 'card-a', actionId: action.actionId, actionHash: action.actionHash,
        confirmedAt: CONFIRMED_AT, stepUpVerified: false,
      } }), 'APPROVAL_PROOF_MISMATCH'],
      ['invalid card id', (action) => ({ decision: 'confirmed', proof: {
        cardId: 'bad card', actionId: action.actionId, actionHash: action.actionHash,
        confirmedAt: CONFIRMED_AT, stepUpVerified: true,
      } }), 'APPROVAL_PROOF_MISMATCH'],
      ['invalid timestamp', (action) => ({ decision: 'confirmed', proof: {
        cardId: 'card-a', actionId: action.actionId, actionHash: action.actionHash,
        confirmedAt: 'not-a-time', stepUpVerified: true,
      } }), 'APPROVAL_PROOF_MISMATCH'],
    ]

    for (const [_name, decision, code] of cases) {
      const h = harness({ decision })
      await expect(h.authority.authorize(request())).rejects.toThrowError(
        expect.objectContaining({ code }),
      )
      expect(h.calls).toEqual(['approve'])
    }
  })

  it('rejects stale or future confirmations before issuing a receipt', async () => {
    for (const confirmedAt of [
      new Date(NOW - 15 * 60_000 - 1).toISOString(),
      new Date(NOW + 1).toISOString(),
    ]) {
      const h = harness({ decision: (action) => ({ decision: 'confirmed', proof: {
        cardId: 'card-a', actionId: action.actionId, actionHash: action.actionHash,
        confirmedAt, stepUpVerified: true,
      } }) })
      await expect(h.authority.authorize(request())).rejects.toThrowError(
        expect.objectContaining({ code: 'APPROVAL_PROOF_STALE' }),
      )
      expect(h.calls).toEqual(['approve'])
    }
  })

  it('fails before approval for foreign scope or malformed immutable target identity', async () => {
    for (const candidate of [
      request({ scope: { kind: 'project', scopeId: 'project:project-b', projectId: 'project-b' } }),
      request({ contentHash: 'not-a-hash' }),
      request({ sourcePath: '../fact.md' }),
    ]) {
      const h = harness()
      await expect(h.authority.authorize(candidate)).rejects.toThrowError(
        new MemoryPermanenceAuthorityError('INVALID_REQUEST'),
      )
      expect(h.calls).toEqual([])
    }
  })

  it('fails closed when durable consume or audit delivery fails', async () => {
    const consumeFailure = harness({ consume: false })
    await expect(consumeFailure.authority.authorize(request())).rejects.toThrowError(
      expect.objectContaining({ code: 'RECEIPT_CONSUME_FAILED' }),
    )
    expect(consumeFailure.calls).toEqual(['approve', 'issue', 'consume'])

    const auditFailure = harness({ auditError: new Error('audit unavailable') })
    await expect(auditFailure.authority.authorize(request())).rejects.toThrow('audit unavailable')
    expect(auditFailure.calls).toEqual(['approve', 'issue', 'consume', 'audit'])
  })

  it('rejects invalid secrets, clocks, and TTLs deterministically', async () => {
    expect(() => makeMemoryPermanenceAuthority({
      secret: Buffer.alloc(31), nowMs: () => NOW, newActionId: () => 'a',
      newReceiptId: () => 'r', nonces: { issue() {}, consume: () => true },
      approve: async () => ({ decision: 'rejected' }), deliverAuditOnce: async () => {},
    })).toThrowError(expect.objectContaining({ code: 'INVALID_AUTHORITY_SECRET' }))

    const badClock = harness({ nowMs: () => Number.NaN })
    await expect(badClock.authority.authorize(request())).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    )
  })
})

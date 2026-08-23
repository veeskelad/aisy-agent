import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeGateway,
  type MemoryPermanenceAuditEvent,
  type MemoryPermanenceAuthorizationRequest,
} from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'
import { makeNodeMemoryPermanenceRuntime } from './memory-permanence-runtime.js'

const NOW = Date.parse('2026-07-27T12:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function request(): MemoryPermanenceAuthorizationRequest {
  return {
    lease: {
      operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
      projectKind: 'project', sessionId: 'session-a', root: '/safe/project-a',
      generation: 2, leaseId: 'lease-a',
    },
    scope: { kind: 'project', scopeId: 'project:project-a', projectId: 'project-a' },
    factId: 'fact-a',
    targetOperationId: 'a'.repeat(64),
    factKey: 'b'.repeat(64),
    sourcePath: `memory/facts/${'c'.repeat(64)}.md`,
    contentHash: 'd'.repeat(64),
    reason: 'Запрос оператора',
  }
}

describe('NodeMemoryPermanenceRuntime', () => {
  it('connects an exact Gateway step-up proof to durable consume and audit', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-permanence-runtime-')))
    roots.push(root)
    const audits: MemoryPermanenceAuditEvent[] = []
    const gateway = makeGateway({
      getAllowedChatId: async () => 42,
      getBotToken: async () => 'unused',
      isReady: () => true,
      transcribeVoice: async () => '',
      isOutboundLocked: () => false,
      isSafetyAvailable: () => true,
      now: () => NOW,
      mintNonce: () => 'nonce-a',
      verifyStepUp: (proof) => proof === 'operator-step-up',
    })
    const noncePath = join(root, 'state', 'memory-permanence.json')
    const runtime = makeNodeMemoryPermanenceRuntime({
      secret: Buffer.alloc(32, 7),
      noncePath,
      nowMs: () => NOW,
      newActionId: () => 'action-a',
      newReceiptId: () => 'receipt-a',
      async approve(_lease, action) {
        const cardId = await gateway.issueCard(action)
        const card = gateway.getIssuedCard(cardId)
        if (!card) return { decision: 'rejected' }
        const result = await gateway.handleCardTap({
          cardId,
          nonce: card.nonce,
          presentedActionHash: card.actionHash,
          chatId: 42,
          stepUpProof: 'operator-step-up',
        })
        if (result.decision !== 'confirmed') return { decision: 'rejected' }
        if (!result.proof) throw new Error('Gateway approval proof expected')
        return { decision: 'confirmed', proof: result.proof }
      },
      deliverAuditOnce: async (event) => { audits.push(structuredClone(event)) },
    })

    await expect(runtime.authorizeHumanConfirmedDelete(request())).resolves.toBe(true)
    expect(audits).toEqual([expect.objectContaining({
      eventId: 'receipt-a',
      actionId: 'action-a',
      factId: 'fact-a',
      stepUpVerified: true,
    })])
    expect(readFileSync(noncePath, 'utf8')).toContain('"status": "consumed"')
  })

  it('returns false on explicit rejection without creating durable state', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-permanence-reject-')))
    roots.push(root)
    const runtime = makeNodeMemoryPermanenceRuntime({
      secret: Buffer.alloc(32, 8),
      noncePath: join(root, 'state', 'memory-permanence.json'),
      nowMs: () => NOW,
      newActionId: () => 'action-a',
      newReceiptId: () => 'receipt-a',
      approve: async () => ({ decision: 'rejected' }),
      deliverAuditOnce: async () => { throw new Error('must not audit') },
    })
    await expect(runtime.authorizeHumanConfirmedDelete(request())).resolves.toBe(false)
  })
})

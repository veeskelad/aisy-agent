import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeMonitoringFollowupEngine, makeMonitoringStore, MonitoringError } from './index.js'
import type {
  MonitoringActionProposalV1,
  MonitoringFollowupActionFamily,
  MonitoringFollowupApprovalConsumer,
  MonitoringFollowupApprovalProof,
  MonitoringFollowupExecutionReceipt,
  MonitoringStore,
} from './types.js'

const NOW = '2026-07-28T08:00:00.000Z'
const PROJECT_A = {
  operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
  sessionId: 'monitor-a', scope: 'project' as const,
}
const PROJECT_B = { ...PROJECT_A, projectId: 'project-b', sessionId: 'monitor-b' }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function testDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'aisy-followups-'))
  roots.push(root)
  return join(root, 'monitoring.db')
}

function saveDigest(store: MonitoringStore): void {
  store.saveDigest({
    schemaVersion: 1,
    id: 'digest-a',
    binding: PROJECT_A,
    windowStart: '2026-07-28T00:00:00.000Z',
    windowEnd: '2026-07-28T07:00:00.000Z',
    notBefore: NOW,
    expiresAt: '2026-07-29T08:00:00.000Z',
    createdAt: NOW,
    status: 'ready',
    items: [{
      evidenceId: 'evidence-a', sourceId: 'source-a', primaryUrl: 'https://example.com/a',
      title: 'Release', summary: 'Released', whyUseful: 'Relevant', category: 'important',
      rawScore: 0.9, rankScore: 0.9,
    }],
  })
}

function executionReceipt(proposal: MonitoringActionProposalV1): MonitoringFollowupExecutionReceipt {
  return {
    schemaVersion: 1,
    proposalId: proposal.id,
    actionHash: proposal.actionHash,
    idempotencyKey: proposal.idempotencyKey,
    receiptId: `receipt-${proposal.id}`,
    occurredAt: NOW,
  }
}

function action(options: {
  tier?: 1 | 2 | 3
  verified?: boolean
  precondition?: boolean
  execute?: MonitoringFollowupActionFamily['execute']
  recoverReceipt?: MonitoringFollowupActionFamily['recoverReceipt']
} = {}) {
  const family: MonitoringFollowupActionFamily = {
    kind: 'test.action',
    tier: options.tier ?? 2,
    validateParameters(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('bad')
      return value as Record<string, unknown>
    },
    precondition: vi.fn(async () => options.precondition === false
      ? { ok: false as const, code: 'FOLLOWUP_PRECONDITION_FAILED' as const }
      : { ok: true as const, snapshotHash: 'b'.repeat(64) }),
    execute: vi.fn(options.execute ?? (async ({ proposal }) => executionReceipt(proposal))),
    recoverReceipt: vi.fn(options.recoverReceipt ?? (async () => null)),
    verify: vi.fn(async ({ proposal, receipt }) => ({
      schemaVersion: 1 as const,
      proposalId: proposal.id,
      actionHash: proposal.actionHash,
      executionReceiptId: receipt.receiptId,
      probeHash: 'c'.repeat(64),
      verified: options.verified ?? true,
      verifiedAt: NOW,
    })),
  }
  return family
}

function harness(options: {
  dbPath?: string
  family?: MonitoringFollowupActionFamily
  bindingActive?: () => boolean
  id?: string
} = {}) {
  const dbPath = options.dbPath ?? testDb()
  const store = makeMonitoringStore({ dbPath })
  if (store.getDigest('digest-a') === null) saveDigest(store)
  const family = options.family ?? action()
  const issued = new Map<string, { proof: MonitoringFollowupApprovalProof; stepUpVerified: boolean }>()
  const minted = new Set<string>()
  let approvalNumber = 0
  const receiptKey = (value: {
    proposalId: string; actionHash: string; cardId: string; challengeId: string
  }) => [value.proposalId, value.actionHash, value.cardId, value.challengeId].join('\u0000')
  const approvalConsumer: MonitoringFollowupApprovalConsumer = {
    consume: vi.fn<MonitoringFollowupApprovalConsumer['consume']>(({ proof, proposalId, actionHash }) => {
      const record = issued.get(proof.token)
      if (record === undefined || record.proof.proposalId !== proposalId ||
        record.proof.actionHash !== actionHash || record.proof.cardId !== proof.cardId ||
        record.proof.challengeId !== proof.challengeId) return null
      issued.delete(proof.token)
      const receipt = {
        schemaVersion: 1 as const,
        proposalId,
        actionHash,
        cardId: proof.cardId,
        challengeId: proof.challengeId,
        confirmedAt: NOW,
        provenance: 'gateway-issued' as const,
        stepUpVerified: record.stepUpVerified,
      }
      minted.add(receiptKey(receipt))
      return receipt
    }),
    validate: vi.fn<MonitoringFollowupApprovalConsumer['validate']>(({ receipt }) =>
      minted.has(receiptKey(receipt))),
  }
  const engine = makeMonitoringFollowupEngine({
    dbPath,
    monitoring: store,
    actions: new Map([[family.kind, family]]),
    approvalConsumer,
    resolveBinding: () => {
      if (options.bindingActive?.() === false) throw new Error('unavailable')
    },
    nowIso: () => NOW,
    newId: () => options.id ?? 'followup-a',
    newClaimToken: () => 'claim-a',
  })
  return {
    approvalConsumer,
    dbPath,
    engine,
    family,
    issueApproval(proposal: MonitoringActionProposalV1, stepUpVerified = false) {
      const token = `issued-${++approvalNumber}`
      const proof: MonitoringFollowupApprovalProof = {
        schemaVersion: 1,
        proposalId: proposal.id,
        actionHash: proposal.actionHash,
        cardId: `card-${proposal.id}`,
        challengeId: `challenge-${approvalNumber}`,
        token,
      }
      issued.set(token, { proof, stepUpVerified })
      return proof
    },
    store,
  }
}

function propose(h: ReturnType<typeof harness>, binding = PROJECT_A) {
  return h.engine.propose({
    binding,
    digestId: 'digest-a',
    evidenceIds: ['evidence-a'],
    actionKind: h.family.kind,
    parameters: { target: 'release', enabled: true },
    summary: 'Предлагается проверить релиз.',
    expiresAt: '2026-07-29T08:00:00.000Z',
  })
}

function approve(h: ReturnType<typeof harness>, stepUpVerified = false) {
  const proposal = propose(h)
  h.engine.recordProposalDelivery(proposal.id, proposal.actionHash, 'proposal-delivery-a')
  return h.engine.approve(proposal.id, h.issueApproval(proposal, stepUpVerified))
}

describe('monitoring verified follow-ups', () => {
  it('persists an immutable evidence-bound proposal and deduplicates semantic retries', () => {
    const h = harness()
    const first = propose(h)
    const second = propose(h)

    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({
      status: 'proposed', tier: 2, digestId: 'digest-a',
      evidence: [{ evidenceId: 'evidence-a', sourceId: 'source-a' }],
    })
    expect(first.evidenceSnapshotHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.actionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.parameters)).toBe(true)
  })

  it('rejects cross-project evidence binding before any proposal is persisted', () => {
    const h = harness()

    expect(() => propose(h, PROJECT_B)).toThrowError(expect.objectContaining<Partial<MonitoringError>>({
      code: 'FOLLOWUP_EVIDENCE_MISMATCH',
    }))
    const db = new Database(h.dbPath, { readonly: true })
    expect((db.prepare('SELECT count(*) AS n FROM monitoring_followups').get() as { n: number }).n).toBe(0)
    db.close()
  })

  it('requires exact one-shot approval and Tier-3 step-up before execution', async () => {
    const family = action({ tier: 3 })
    const h = harness({ family })
    const proposal = propose(h)
    h.engine.recordProposalDelivery(proposal.id, proposal.actionHash, 'delivered')

    expect(() => h.engine.approve(proposal.id, h.issueApproval(proposal, false)))
      .toThrowError(expect.objectContaining<Partial<MonitoringError>>({
      code: 'FOLLOWUP_APPROVAL_INVALID',
    }))
    h.engine.approve(proposal.id, h.issueApproval(proposal, true))
    await expect(h.engine.execute(proposal.id)).resolves.toMatchObject({ status: 'verified' })
    await expect(h.engine.execute(proposal.id)).resolves.toMatchObject({ status: 'skipped' })
    expect(family.execute).toHaveBeenCalledTimes(1)
  })

  it('rejects fabricated approval credentials and consumes a valid proof once', () => {
    const h = harness()
    const proposal = propose(h)
    h.engine.recordProposalDelivery(proposal.id, proposal.actionHash, 'delivered')
    const fabricated: MonitoringFollowupApprovalProof = {
      schemaVersion: 1,
      proposalId: proposal.id,
      actionHash: proposal.actionHash,
      cardId: `card-${proposal.id}`,
      challengeId: 'challenge-fabricated',
      token: 'fabricated-token',
    }
    expect(() => h.engine.approve(proposal.id, fabricated)).toThrowError(
      expect.objectContaining<Partial<MonitoringError>>({ code: 'FOLLOWUP_APPROVAL_INVALID' }),
    )

    const issued = h.issueApproval(proposal)
    expect(h.engine.approve(proposal.id, issued)).toMatchObject({ status: 'approved' })
    expect(() => h.engine.approve(proposal.id, issued)).toThrowError(
      expect.objectContaining<Partial<MonitoringError>>({ code: 'FOLLOWUP_APPROVAL_INVALID' }),
    )
    expect(h.approvalConsumer.consume).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['parameters_json', '{"enabled":false,"target":"release"}'],
    ['idempotency_key', 'monitoring-followup:tampered'],
  ])('quarantines post-approval authority tampering in %s', async (column, value) => {
    const family = action()
    const h = harness({ family })
    const approved = approve(h)
    const db = new Database(h.dbPath)
    db.prepare(`UPDATE monitoring_followups SET ${column}=? WHERE id=?`).run(value, approved.id)
    db.close()

    await expect(h.engine.execute(approved.id)).resolves.toEqual({
      proposalId: approved.id, status: 'quarantined', code: 'FOLLOWUP_QUARANTINED',
    })
    expect(family.precondition).not.toHaveBeenCalled()
    expect(family.execute).not.toHaveBeenCalled()
  })

  it('quarantines a fabricated persisted approval receipt with asserted provenance', async () => {
    const family = action()
    const h = harness({ family })
    const approved = approve(h)
    const forged = {
      ...approved.approval,
      cardId: 'card-forged',
      challengeId: 'challenge-forged',
    }
    const db = new Database(h.dbPath)
    db.prepare('UPDATE monitoring_followups SET approval_json=? WHERE id=?')
      .run(JSON.stringify(forged), approved.id)
    db.close()

    await expect(h.engine.execute(approved.id)).resolves.toEqual({
      proposalId: approved.id, status: 'quarantined', code: 'FOLLOWUP_QUARANTINED',
    })
    expect(family.execute).not.toHaveBeenCalled()
  })

  it('blocks on a fresh precondition failure without mutation', async () => {
    const family = action({ precondition: false })
    const h = harness({ family })
    const approved = approve(h)

    await expect(h.engine.execute(approved.id)).resolves.toEqual({
      proposalId: approved.id, status: 'blocked', code: 'FOLLOWUP_PRECONDITION_FAILED',
    })
    expect(family.execute).not.toHaveBeenCalled()
    expect(h.engine.get(approved.id)).toMatchObject({ status: 'blocked', attempts: 1 })
  })

  it('expires a direct execution attempt after the approved action deadline', async () => {
    const family = action()
    const h = harness({ family })
    const approved = approve(h)
    const db = new Database(h.dbPath)
    db.prepare("UPDATE monitoring_followups SET expires_at='2026-07-28T07:59:59.000Z' WHERE id=?")
      .run(approved.id)
    db.close()

    await expect(h.engine.execute(approved.id)).resolves.toEqual({
      proposalId: approved.id, status: 'skipped',
    })
    expect(h.engine.get(approved.id)).toMatchObject({ status: 'expired' })
    expect(family.execute).not.toHaveBeenCalled()
  })

  it('uses a CAS lease so concurrent workers mutate at most once', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const family = action({ execute: async ({ proposal }) => {
      await gate
      return executionReceipt(proposal)
    } })
    const h = harness({ family })
    const approved = approve(h)

    const first = h.engine.execute(approved.id)
    await vi.waitFor(() => expect(family.execute).toHaveBeenCalledTimes(1))
    const second = h.engine.execute(approved.id)
    await expect(second).resolves.toMatchObject({ status: 'skipped' })
    release()
    await expect(first).resolves.toMatchObject({ status: 'verified' })
    expect(family.execute).toHaveBeenCalledTimes(1)
  })

  it('revalidates exact binding after awaited precondition and before mutation', async () => {
    let active = true
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const family = action()
    family.precondition = vi.fn(async () => {
      await gate
      return { ok: true as const, snapshotHash: 'b'.repeat(64) }
    })
    const h = harness({ family, bindingActive: () => active })
    const approved = approve(h)

    const pending = h.engine.execute(approved.id)
    await vi.waitFor(() => expect(family.precondition).toHaveBeenCalledTimes(1))
    active = false
    release()

    await expect(pending).resolves.toEqual({
      proposalId: approved.id, status: 'paused', code: 'FOLLOWUP_BINDING_UNAVAILABLE',
    })
    expect(family.execute).not.toHaveBeenCalled()
    expect(h.engine.get(approved.id)).toMatchObject({ status: 'paused', pausedFrom: 'approved' })
  })

  it('revalidates persisted action authority after awaited precondition', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const family = action()
    family.precondition = vi.fn(async () => {
      await gate
      return { ok: true as const, snapshotHash: 'b'.repeat(64) }
    })
    const h = harness({ family })
    const approved = approve(h)

    const pending = h.engine.execute(approved.id)
    await vi.waitFor(() => expect(family.precondition).toHaveBeenCalledTimes(1))
    const db = new Database(h.dbPath)
    db.prepare("UPDATE monitoring_followups SET parameters_json='{}' WHERE id=?").run(approved.id)
    db.close()
    release()

    await expect(pending).resolves.toEqual({
      proposalId: approved.id, status: 'quarantined', code: 'FOLLOWUP_QUARANTINED',
    })
    expect(family.execute).not.toHaveBeenCalled()
  })

  it('recovers an execution receipt after restart instead of repeating mutation', async () => {
    const recoveredFamily = action({ recoverReceipt: async ({ proposal }) => executionReceipt(proposal) })
    const h = harness({ family: recoveredFamily })
    const approved = approve(h)
    const db = new Database(h.dbPath)
    db.prepare(`UPDATE monitoring_followups SET status='executing', claim_token='dead-worker',
      claim_until='2026-07-28T07:00:00.000Z', attempts=1, revision=revision+1 WHERE id=?`).run(approved.id)
    db.close()

    const restarted = harness({ dbPath: h.dbPath, family: recoveredFamily })
    await expect(restarted.engine.execute(approved.id)).resolves.toMatchObject({ status: 'verified' })
    expect(recoveredFamily.recoverReceipt).toHaveBeenCalledTimes(1)
    expect(recoveredFamily.execute).not.toHaveBeenCalled()
  })

  it('does not treat an execution receipt as success when verification fails', async () => {
    const family = action({ verified: false })
    const h = harness({ family })
    const approved = approve(h)

    await expect(h.engine.execute(approved.id)).resolves.toEqual({
      proposalId: approved.id,
      status: 'reconciliation-required',
      code: 'FOLLOWUP_RECONCILIATION_REQUIRED',
    })
    expect(h.engine.get(approved.id)).toMatchObject({
      status: 'reconciliation-required',
      executionReceipt: { receiptId: `receipt-${approved.id}` },
      verificationReceipt: { verified: false },
    })
  })

  it('records and verifies rollback separately after failed postcondition', async () => {
    const base = action({ verified: false })
    const family: MonitoringFollowupActionFamily = {
      ...base,
      rollback: vi.fn(async ({ proposal, idempotencyKey }) => ({
        schemaVersion: 1 as const,
        proposalId: proposal.id,
        actionHash: proposal.actionHash,
        idempotencyKey,
        receiptId: `rollback-${proposal.id}`,
        occurredAt: NOW,
      })),
      recoverRollbackReceipt: vi.fn(async () => null),
      verifyRollback: vi.fn(async ({ proposal, receipt }) => ({
        schemaVersion: 1 as const,
        proposalId: proposal.id,
        actionHash: proposal.actionHash,
        rollbackReceiptId: receipt.receiptId,
        probeHash: 'd'.repeat(64),
        rolledBack: true,
        verifiedAt: NOW,
      })),
    }
    const h = harness({ family })
    const approved = approve(h)

    await expect(h.engine.execute(approved.id)).resolves.toEqual({
      proposalId: approved.id, status: 'rolled-back', code: 'FOLLOWUP_VERIFICATION_FAILED',
    })
    expect(h.engine.get(approved.id)).toMatchObject({
      status: 'rolled-back',
      verificationReceipt: { verified: false },
      rollbackReceipt: { receiptId: `rollback-${approved.id}` },
      rollbackVerificationReceipt: { rolledBack: true },
    })
  })

  it('keeps an uncertain rollback recoverable and verifies it after restart', async () => {
    const base = action({ verified: false })
    const firstFamily: MonitoringFollowupActionFamily = {
      ...base,
      rollback: vi.fn(async () => null),
      recoverRollbackReceipt: vi.fn(async () => null),
      verifyRollback: vi.fn(async () => { throw new Error('not reached') }),
    }
    const h = harness({ family: firstFamily })
    const approved = approve(h)

    await expect(h.engine.execute(approved.id)).resolves.toEqual({
      proposalId: approved.id,
      status: 'rollback-pending',
      code: 'FOLLOWUP_RECONCILIATION_REQUIRED',
    })
    expect(h.engine.get(approved.id)).toMatchObject({ status: 'rollback-pending' })

    const recoveredFamily: MonitoringFollowupActionFamily = {
      ...action({ verified: false }),
      rollback: vi.fn(async () => null),
      recoverRollbackReceipt: vi.fn(async ({ proposal, idempotencyKey }) => ({
        schemaVersion: 1 as const,
        proposalId: proposal.id,
        actionHash: proposal.actionHash,
        idempotencyKey,
        receiptId: `rollback-${proposal.id}`,
        occurredAt: NOW,
      })),
      verifyRollback: vi.fn(async ({ proposal, receipt }) => ({
        schemaVersion: 1 as const,
        proposalId: proposal.id,
        actionHash: proposal.actionHash,
        rollbackReceiptId: receipt.receiptId,
        probeHash: 'd'.repeat(64),
        rolledBack: true,
        verifiedAt: NOW,
      })),
    }
    const restarted = harness({ dbPath: h.dbPath, family: recoveredFamily })
    await expect(restarted.engine.execute(approved.id)).resolves.toEqual({
      proposalId: approved.id, status: 'rolled-back', code: 'FOLLOWUP_VERIFICATION_FAILED',
    })
    expect(recoveredFamily.recoverRollbackReceipt).toHaveBeenCalledTimes(1)
  })

  it('quarantines corrupt persisted authority instead of returning it', () => {
    const h = harness()
    const proposal = propose(h)
    const db = new Database(h.dbPath)
    db.prepare("UPDATE monitoring_followups SET binding_json='{}' WHERE id=?").run(proposal.id)
    db.close()

    expect(h.engine.get(proposal.id)).toBeNull()
    const audit = new Database(h.dbPath, { readonly: true })
    expect(audit.prepare('SELECT status,last_code FROM monitoring_followups WHERE id=?')
      .get(proposal.id)).toEqual({ status: 'quarantined', last_code: 'FOLLOWUP_QUARANTINED' })
    audit.close()
  })

  it('pauses a newly claimed approval if its exact binding disappears before mutation', async () => {
    let active = true
    const family = action()
    const h = harness({ family, bindingActive: () => active })
    const approved = approve(h)
    active = false

    await expect(h.engine.execute(approved.id)).resolves.toEqual({
      proposalId: approved.id, status: 'paused', code: 'FOLLOWUP_BINDING_UNAVAILABLE',
    })
    expect(h.engine.get(approved.id)).toMatchObject({ status: 'paused', pausedFrom: 'approved' })
    expect(family.execute).not.toHaveBeenCalled()

    active = true
    expect(h.engine.resumePaused(approved.id)).toMatchObject({ status: 'approved' })
    await expect(h.engine.execute(approved.id)).resolves.toMatchObject({ status: 'verified' })
    expect(family.execute).toHaveBeenCalledTimes(1)
  })

  it('resumes a temporarily paused proposal but expires it after its deadline', () => {
    let active = true
    const h = harness({ bindingActive: () => active })
    const proposal = propose(h)
    active = false
    expect(h.engine.listForProposalDelivery(1)).toEqual([])
    expect(h.engine.get(proposal.id)).toMatchObject({ status: 'paused', pausedFrom: 'proposed' })

    active = true
    expect(h.engine.resumePaused(proposal.id)).toMatchObject({ status: 'proposed' })
    active = false
    expect(h.engine.listForProposalDelivery(1)).toEqual([])
    const db = new Database(h.dbPath)
    db.prepare("UPDATE monitoring_followups SET expires_at='2026-07-28T07:00:00.000Z' WHERE id=?")
      .run(proposal.id)
    db.close()
    active = true
    expect(h.engine.resumePaused(proposal.id)).toMatchObject({ status: 'expired' })
  })
})

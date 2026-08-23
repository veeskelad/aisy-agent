import { describe, expect, it, vi } from 'vitest'

import {
  makeMonitoringFollowupExecutionCoordinator,
  makeMonitoringFollowupProposalCoordinator,
  type MonitoringFollowupCoordinatorEngine,
  type MonitoringFollowupProposalDeliveryPort,
} from './monitoring-followup-runtime.js'

const PROPOSAL = Object.freeze({
  schemaVersion: 1 as const,
  id: 'followup-1',
  digestId: 'digest-1',
  evidence: [{
    evidenceId: 'evidence-1', sourceId: 'source-1', primaryUrl: 'https://example.com/release',
  }],
  evidenceSnapshotHash: 'b'.repeat(64),
  actionKind: 'release.verify',
  parameters: { repository: 'aisy', ref: 'v1.0.0' },
  actionHash: 'a'.repeat(64),
  idempotencyKey: 'monitoring-followup:followup-1:hash',
  tier: 2 as const,
  summary: 'Проверить опубликованный релиз.',
  expiresAt: '2026-07-29T08:00:00.000Z',
  status: 'proposed',
})

function engine(overrides: Partial<MonitoringFollowupCoordinatorEngine> = {}) {
  return {
    listForProposalDelivery: vi.fn(() => []),
    recordProposalDelivery: vi.fn((_id, _hash, _receipt) => PROPOSAL),
    listExecutable: vi.fn(() => []),
    execute: vi.fn(async (id) => ({ proposalId: id, status: 'verified' })),
    ...overrides,
  } satisfies MonitoringFollowupCoordinatorEngine
}

describe('monitoring follow-up coordinators', () => {
  it('performs zero calls at construction and validates bounded ticks', async () => {
    const service = engine()
    const deliver = vi.fn<MonitoringFollowupProposalDeliveryPort['deliver']>()

    const proposalCoordinator = makeMonitoringFollowupProposalCoordinator({
      engine: service, delivery: { deliver },
    })
    const executionCoordinator = makeMonitoringFollowupExecutionCoordinator({ engine: service })

    expect(service.listForProposalDelivery).not.toHaveBeenCalled()
    expect(service.listExecutable).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    await expect(proposalCoordinator.tick(0)).rejects.toThrow(RangeError)
    await expect(executionCoordinator.tick(101)).rejects.toThrow(RangeError)
  })

  it('records only non-empty proposal delivery receipts with a stable key', async () => {
    const service = engine({ listForProposalDelivery: vi.fn(() => [PROPOSAL]) })
    const deliver = vi.fn<MonitoringFollowupProposalDeliveryPort['deliver']>()
      .mockResolvedValueOnce(' delivery-receipt ')
    const coordinator = makeMonitoringFollowupProposalCoordinator({
      engine: service, delivery: { deliver },
    })

    await expect(coordinator.tick(1)).resolves.toEqual({
      due: 1, attempted: 1, delivered: 1, noReceipt: 0, failed: 0,
    })
    expect(deliver).toHaveBeenCalledWith({
      card: {
        schemaVersion: 1,
        proposalId: PROPOSAL.id,
        digestId: PROPOSAL.digestId,
        action: {
          kind: PROPOSAL.actionKind,
          summary: PROPOSAL.summary,
          parameters: PROPOSAL.parameters,
        },
        tier: PROPOSAL.tier,
        expiresAt: PROPOSAL.expiresAt,
        evidence: PROPOSAL.evidence,
        evidenceSnapshotHash: PROPOSAL.evidenceSnapshotHash,
        actionHash: PROPOSAL.actionHash,
      },
      idempotencyKey: `${PROPOSAL.idempotencyKey}:proposal`,
    })
    const card = deliver.mock.calls[0]?.[0].card
    if (card === undefined) throw new Error('missing approval card')
    expect(card).not.toHaveProperty('text')
    expect(card.evidence[0]).toEqual({
      evidenceId: 'evidence-1', sourceId: 'source-1', primaryUrl: 'https://example.com/release',
    })
    expect(service.recordProposalDelivery).toHaveBeenCalledWith(
      PROPOSAL.id, PROPOSAL.actionHash, 'delivery-receipt',
    )
    expect(service.execute).not.toHaveBeenCalled()
  })

  it('keeps missing receipts retryable and redacts adapter failures', async () => {
    const second = { ...PROPOSAL, id: 'followup-2' }
    const service = engine({ listForProposalDelivery: vi.fn(() => [PROPOSAL, second]) })
    const deliver = vi.fn<MonitoringFollowupProposalDeliveryPort['deliver']>()
      .mockResolvedValueOnce('   ')
      .mockRejectedValueOnce(new Error('secret transport details'))
    const coordinator = makeMonitoringFollowupProposalCoordinator({
      engine: service, delivery: { deliver },
    })

    await expect(coordinator.tick(2)).resolves.toEqual({
      due: 2, attempted: 2, delivered: 0, noReceipt: 1, failed: 1,
    })
    expect(service.recordProposalDelivery).not.toHaveBeenCalled()
  })

  it('executes only engine-listed proposals and reports stable status counts', async () => {
    const second = { ...PROPOSAL, id: 'followup-2', status: 'approved' }
    const service = engine({
      listExecutable: vi.fn(() => [PROPOSAL, second]),
      execute: vi.fn()
        .mockResolvedValueOnce({ proposalId: PROPOSAL.id, status: 'verified' })
        .mockResolvedValueOnce({ proposalId: second.id, status: 'skipped' }),
    })
    const coordinator = makeMonitoringFollowupExecutionCoordinator({ engine: service })

    await expect(coordinator.tick(2)).resolves.toEqual({
      due: 2, attempted: 2, completed: 1, skipped: 1, failed: 0,
      byStatus: { verified: 1, skipped: 1 },
    })
    expect(service.execute).toHaveBeenNthCalledWith(1, PROPOSAL.id)
    expect(service.execute).toHaveBeenNthCalledWith(2, second.id)
  })
})

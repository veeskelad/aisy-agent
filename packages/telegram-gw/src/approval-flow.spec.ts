import { describe, it, expect } from 'vitest'
import {
  NonceReplay,
  NonceStale,
  ActionHashMismatch,
  StepUpRequired,
  StepUpFailed,
  NoSuchPendingAction,
} from '@aisy/core'
import type { PendingAction, CardTap, IssuedCardView, ApprovalResult } from '@aisy/core'
import { resolveTap, type ApprovalFlowDeps } from './approval-flow.js'
import type { CardCallback } from './approval-card.js'

function action(overrides?: Partial<PendingAction>): PendingAction {
  return {
    actionId: 'act-001',
    actionHash: 'sha256-abc',
    tier: 1,
    requiresStepUp: false,
    summary: 'rm -rf dist/',
    ...overrides,
  }
}

const VIEW: IssuedCardView = {
  cardId: 'card-1',
  actionId: 'act-001',
  actionHash: 'sha256-abc',
  nonce: 'nonce-1',
  requiresStepUp: false,
  redVariant: false,
  expiresAt: 999,
}

/** Build deps with a controllable handleCardTap. captures the tap it received. */
function makeDeps(
  handle: (tap: CardTap) => Promise<ApprovalResult>,
  view: IssuedCardView | null = VIEW,
): { deps: ApprovalFlowDeps; taps: CardTap[] } {
  const taps: CardTap[] = []
  return {
    taps,
    deps: {
      now: () => '14:32:01',
      gateway: {
        getIssuedCard: () => view,
        handleCardTap: (tap) => {
          taps.push(tap)
          return handle(tap)
        },
      },
    },
  }
}

const confirmCb: CardCallback = { cardId: 'card-1', nonce: 'nonce-1', verb: 'confirm' }

describe('resolveTap', () => {
  it('reject is handled adapter-side without touching the gateway', async () => {
    const { deps, taps } = makeDeps(async () => ({ decision: 'confirmed', actionId: 'x' }))
    const out = await resolveTap({ ...confirmCb, verb: 'reject' }, 42, action(), deps)
    expect(out.kind).toBe('rejected')
    if (out.kind === 'rejected') expect(out.footer).toContain('❌ Отклонено')
    expect(taps).toHaveLength(0)
  })

  it('info short-circuits with no gateway call', async () => {
    const { deps, taps } = makeDeps(async () => ({ decision: 'confirmed', actionId: 'x' }))
    expect((await resolveTap({ ...confirmCb, verb: 'info' }, 42, action(), deps)).kind).toBe('info')
    expect(taps).toHaveLength(0)
  })

  it('confirm echoes the button nonce and the displayed action-hash into the tap', async () => {
    const { deps, taps } = makeDeps(async () => ({ decision: 'confirmed', actionId: 'act-001' }))
    const out = await resolveTap(confirmCb, 42, action(), deps, { stepUpProof: 'correct-horse' })
    expect(out.kind).toBe('confirmed')
    if (out.kind === 'confirmed') {
      expect(out.actionId).toBe('act-001')
      expect(out.footer).toContain('✅ Подтверждено · 14:32:01')
    }
    expect(taps[0]).toEqual({
      cardId: 'card-1',
      nonce: 'nonce-1',
      presentedActionHash: 'sha256-abc',
      chatId: 42,
      approvalScope: 'once',
      stepUpProof: 'correct-horse',
    })
  })

  it('session verb confirms and carries scope=session (tap + outcome)', async () => {
    const { deps, taps } = makeDeps(async (tap) => ({
      decision: 'confirmed',
      actionId: 'act-001',
      ...(tap.approvalScope === 'session' || tap.approvalScope === 'always'
        ? { scope: tap.approvalScope }
        : {}),
    }))
    const out = await resolveTap({ ...confirmCb, verb: 'session' }, 42, action(), deps)
    expect(out.kind).toBe('confirmed')
    if (out.kind === 'confirmed') expect(out.scope).toBe('session')
    expect(taps[0]!.approvalScope).toBe('session')
  })

  it('always verb carries scope=always', async () => {
    const { deps } = makeDeps(async (tap) => ({
      decision: 'confirmed',
      actionId: 'act-001',
      ...(tap.approvalScope === 'always' ? { scope: 'always' as const } : {}),
    }))
    const out = await resolveTap({ ...confirmCb, verb: 'always' }, 42, action(), deps)
    if (out.kind === 'confirmed') expect(out.scope).toBe('always')
  })

  it('plain confirm sends approvalScope=once and yields no remembered scope', async () => {
    const { deps, taps } = makeDeps(async () => ({ decision: 'confirmed', actionId: 'act-001' }))
    const out = await resolveTap(confirmCb, 42, action(), deps)
    expect(taps[0]!.approvalScope).toBe('once')
    if (out.kind === 'confirmed') expect(out.scope).toBeUndefined()
  })

  it('omits stepUpProof when not provided', async () => {
    const { deps, taps } = makeDeps(async () => ({ decision: 'confirmed', actionId: 'act-001' }))
    await resolveTap(confirmCb, 42, action(), deps)
    expect('stepUpProof' in taps[0]!).toBe(false)
  })

  it('expired card (getIssuedCard null) short-circuits before any tap', async () => {
    const { deps, taps } = makeDeps(async () => ({ decision: 'confirmed', actionId: 'x' }), null)
    expect((await resolveTap(confirmCb, 42, action(), deps)).kind).toBe('expired')
    expect(taps).toHaveLength(0)
  })

  it.each([
    [new StepUpRequired('act-001'), 'stepup_required'],
    [new StepUpFailed('act-001'), 'stepup_failed'],
    [new NonceReplay('card-1'), 'replay'],
    [new NonceStale('card-1'), 'expired'],
    [new NoSuchPendingAction('card-1'), 'expired'],
    [new ActionHashMismatch('card-1'), 'hash_mismatch'],
  ])('maps %s to outcome %s', async (err, expected) => {
    const { deps } = makeDeps(async () => {
      throw err
    })
    expect((await resolveTap(confirmCb, 42, action(), deps)).kind).toBe(expected)
  })

  it('re-throws unexpected errors', async () => {
    const { deps } = makeDeps(async () => {
      throw new Error('boom')
    })
    await expect(resolveTap(confirmCb, 42, action(), deps)).rejects.toThrow('boom')
  })
})

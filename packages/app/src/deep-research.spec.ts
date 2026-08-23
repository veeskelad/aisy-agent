import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_RESEARCH_LIMITS,
  makeResearchApproval,
  researchPlan,
  stopNote,
} from './deep-research.js'
import type { PendingAction } from '@aisy/core'

function page(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    actionId: 'a1',
    actionHash: 'h1',
    tier: 2,
    requiresStepUp: false,
    summary: 'fetch_url https://example.com',
    ...overrides,
  }
}

describe('one confirmation for a whole search', () => {
  it('binds automatic page approval to the exact research invocation', () => {
    const production = readFileSync(new URL('./bin/aisy.ts', import.meta.url), 'utf8')

    expect(production).toContain('researchApproval.approve')
    expect(production).not.toContain('activeResearch.approve')
    expect(production).toContain('AbortSignal.timeout(DEFAULT_RESEARCH_LIMITS.maxMs)')
  })

  it('answers page approvals until the page budget is spent', async () => {
    const approval = makeResearchApproval({ maxPages: 3, maxMs: 60_000 }, () => 0)

    for (let i = 0; i < 3; i += 1) {
      await expect(approval.approve(page())).resolves.toEqual({ decision: 'confirmed' })
    }

    await expect(approval.approve(page())).resolves.toEqual({ decision: 'rejected' })
    expect(approval.spent()).toBe(3)
    expect(approval.stopped()).toBe('pages')
  })

  it('never remembers a decision beyond this search', async () => {
    // A `session` or `always` scope would record a similar-grant that outlives
    // the tap the operator actually gave. No scope at all is the only answer
    // that stays inside this one search.
    const approval = makeResearchApproval(DEFAULT_RESEARCH_LIMITS, () => 0)

    const decision = await approval.approve(page())

    expect(decision).toEqual({ decision: 'confirmed' })
    expect('scope' in decision).toBe(false)
  })

  it('stops reading when the search runs out of time', async () => {
    let clock = 0
    const approval = makeResearchApproval({ maxPages: 99, maxMs: 1_000 }, () => clock)

    await expect(approval.approve(page())).resolves.toMatchObject({ decision: 'confirmed' })
    clock = 1_000
    await expect(approval.approve(page())).resolves.toEqual({ decision: 'rejected' })
    expect(approval.stopped()).toBe('deadline')
  })

  it('reports the deadline even when no later page asks for approval', async () => {
    let clock = 0
    const approval = makeResearchApproval({ maxPages: 99, maxMs: 1_000 }, () => clock)

    clock = 1_000

    expect(approval.stopped()).toBe('deadline')
  })

  it('refuses anything that asks for a human, however much budget is left', async () => {
    const approval = makeResearchApproval(DEFAULT_RESEARCH_LIMITS, () => 0)

    await expect(approval.approve(page({ requiresStepUp: true })))
      .resolves.toEqual({ decision: 'rejected' })
    await expect(approval.approve(page({ tier: 3 })))
      .resolves.toEqual({ decision: 'rejected' })
    expect(approval.spent()).toBe(0)
    expect(approval.stopped()).toBe('step-up')
  })

  it('refuses everything when the limits are nonsense', async () => {
    // A zero or fractional budget must fail closed, not read forever.
    for (const limits of [{ maxPages: 0, maxMs: 1_000 }, { maxPages: 1.5, maxMs: 1_000 }]) {
      const approval = makeResearchApproval(limits, () => 0)
      await expect(approval.approve(page())).resolves.toEqual({ decision: 'rejected' })
    }
  })

  it('beats once per confirmed page, and a broken heartbeat costs nothing', async () => {
    const beats: number[] = []
    const approval = makeResearchApproval({ maxPages: 2, maxMs: 60_000 }, () => 0, (spent) => {
      beats.push(spent)
      throw new Error('карточка не нарисовалась')
    })

    await expect(approval.approve(page())).resolves.toEqual({ decision: 'confirmed' })
    await expect(approval.approve(page())).resolves.toEqual({ decision: 'confirmed' })
    // Rejected pages are not progress — no beat for them.
    await expect(approval.approve(page())).resolves.toEqual({ decision: 'rejected' })

    expect(beats).toEqual([1, 2])
  })

  it('carries the question into a single read-only task', () => {
    const plan = JSON.parse(researchPlan('чем harness отличается от агента', 'researcher'))

    expect(plan.nodes).toHaveLength(1)
    expect(plan.nodes[0]).toMatchObject({
      intent: 'чем harness отличается от агента',
      assignedTo: 'researcher',
      scope: { owns: [], doNotTouch: [] },
    })
  })

  it('says out loud when a search was cut short', () => {
    expect(stopNote('pages', 12)).toContain('12 страниц')
    expect(stopNote('deadline', 4)).toContain('по времени')
    expect(stopNote('step-up', 4)).toContain('твоего решения')
    expect(stopNote(null, 4)).toBe('')
  })
})

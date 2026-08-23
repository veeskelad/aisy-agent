import { describe, expect, it } from 'vitest'
import { makeContextLeaseCoordinator, type ResolvedWorkBinding } from '@aisy/core'

import { makeMemoryLeaseSource, MemoryLeaseError } from './memory-lease-source.js'

const OPERATOR = 'telegram:42'
const PROFILE = 'default'

function source(rootFor: (b: ResolvedWorkBinding) => string | null = () => '/Users/operator/projects/a') {
  let n = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++n}` })
  return {
    leases,
    source: makeMemoryLeaseSource({
      leases,
      operatorId: OPERATOR,
      profileId: PROFILE,
      workspace: { projectId: 'workspace-1', root: '/Users/operator/workspace' },
      rootFor,
    }),
  }
}

const binding = (overrides: Partial<ResolvedWorkBinding> = {}): ResolvedWorkBinding => ({
  operatorId: OPERATOR,
  profileId: PROFILE,
  projectId: 'project-a',
  sessionId: 'session-nightly',
  scope: 'project',
  ...overrides,
})

describe('memory lease source (ADR-0074 §5)', () => {
  it('gives maintenance work a Workspace lease of the operator', async () => {
    const { source: leases } = source()
    const seen = await leases.withMaintenanceLease(async lease => lease)

    expect(seen.operatorId).toBe(OPERATOR)
    expect(seen.projectKind).toBe('workspace')
    expect(seen.projectId).toBe('workspace-1')
    expect(seen.root).toBe('/Users/operator/workspace')
  })

  it('binds a background job to the project of its own binding', async () => {
    const { source: leases } = source(() => '/Users/operator/projects/a')
    const seen = await leases.withBackgroundLease(binding(), async lease => lease)

    expect(seen.projectKind).toBe('project')
    expect(seen.projectId).toBe('project-a')
    expect(seen.sessionId).toBe('session-nightly')
    expect(seen.root).toBe('/Users/operator/projects/a')
  })

  it('treats a workspace-scoped binding as workspace, not project', async () => {
    const { source: leases } = source(() => '/Users/operator/workspace')
    const seen = await leases.withBackgroundLease(
      binding({ scope: 'workspace', projectId: 'workspace-1' }),
      async lease => lease,
    )

    expect(seen.projectKind).toBe('workspace')
  })

  it('closes the lease even when the job throws', async () => {
    const { leases, source: leaseSource } = source()
    let captured: { leaseId: string } | null = null

    await expect(leaseSource.withMaintenanceLease(async lease => {
      captured = lease
      throw new Error('nightly exploded')
    })).rejects.toThrow('nightly exploded')

    expect(captured).not.toBeNull()
    // A closed lease can no longer reserve work: the barrier is free again.
    expect(() => leases.reserveOperation(captured as never)).toThrowError()
  })

  it('never lets a background job borrow another operator identity', async () => {
    const { source: leases } = source()

    await expect(leases.withBackgroundLease(binding({ operatorId: 'telegram:99' }), async () => 1))
      .rejects.toThrowError(expect.objectContaining({ reason: 'invalid-binding' }))
    await expect(leases.withBackgroundLease(binding({ profileId: 'other' }), async () => 1))
      .rejects.toThrowError(MemoryLeaseError)
  })

  it('refuses a binding whose project root cannot be resolved', async () => {
    const { source: leases } = source(() => null)

    await expect(leases.withBackgroundLease(binding(), async () => 1))
      .rejects.toThrowError(expect.objectContaining({ reason: 'invalid-binding' }))
  })

  it('refuses an incomplete binding before acquiring anything', async () => {
    const { source: leases } = source()

    await expect(leases.withBackgroundLease(binding({ sessionId: '' }), async () => 1))
      .rejects.toThrowError(MemoryLeaseError)
    await expect(leases.withBackgroundLease(binding({ projectId: '  ' }), async () => 1))
      .rejects.toThrowError(MemoryLeaseError)
  })

  it('hands out a distinct lease per call', async () => {
    const { source: leases } = source()
    const first = await leases.withMaintenanceLease(async lease => lease.leaseId)
    const second = await leases.withMaintenanceLease(async lease => lease.leaseId)

    expect(first).not.toBe(second)
  })

  it('refuses to build a source without a usable workspace context', () => {
    const leases = makeContextLeaseCoordinator({ newId: () => 'lease' })
    expect(() => makeMemoryLeaseSource({
      leases,
      operatorId: OPERATOR,
      profileId: PROFILE,
      workspace: { projectId: '', root: '/Users/operator/workspace' },
      rootFor: () => null,
    })).toThrowError(expect.objectContaining({ reason: 'invalid-workspace' }))
  })
})

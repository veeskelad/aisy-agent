import { describe, expect, it, vi } from 'vitest'
import { makeContextLeaseCoordinator } from './context-lease.js'
import {
  makeProtectedMemoryRecoveryGate,
  type ProtectedMemoryRecoveryStatePort,
} from './protected-memory-recovery-gate.js'
import type { ProtectedMemoryScope } from './protected-memory-publication.js'

const scope: ProtectedMemoryScope = {
  kind: 'project', scopeId: 'project:project-a', projectId: 'project-a',
}

function harness() {
  let publication = 0
  let deletion = 0
  let update = 0
  let integrity = true
  let id = 0
  const leases = makeContextLeaseCoordinator({ newId: () => `recovery-op-${++id}` })
  const lease = leases.acquire({
    operatorId: 'telegram:42', profileId: 'default', projectId: 'project-a',
    projectKind: 'project', sessionId: 'session-a', root: '/tmp/project-a', generation: 7,
  })
  const persistence: ProtectedMemoryRecoveryStatePort = {
    async listWals() { return Array.from({ length: publication }, () => ({})) },
    async listDeletionWals() { return Array.from({ length: deletion }, () => ({})) },
    async listUpdateWals() { return Array.from({ length: update }, () => ({})) },
    integrityCheck: () => ({ ok: integrity }),
  }
  const recoverPublication = vi.fn(async () => { publication = 0; return [] })
  const recoverDeletion = vi.fn(async () => { deletion = 0; return [] })
  const recoverUpdate = vi.fn(async () => { update = 0; return [] })
  const gate = makeProtectedMemoryRecoveryGate({
    leases,
    persistence: () => persistence,
    publication: { recoverScope: recoverPublication },
    deletion: { recoverScope: recoverDeletion },
    update: { recoverScope: recoverUpdate },
    withScopeExclusive: async (_lease, _scope, run) => run(),
  })
  return {
    gate,
    lease,
    recoverDeletion,
    recoverPublication,
    recoverUpdate,
    setCounts: (values: { publication?: number; deletion?: number; update?: number }) => {
      publication = values.publication ?? 0
      deletion = values.deletion ?? 0
      update = values.update ?? 0
    },
    setIntegrity: (value: boolean) => { integrity = value },
  }
}

describe('protected memory unified recovery gate', () => {
  it('atomically blocks a reader for every mutation WAL family', async () => {
    for (const family of ['publication', 'deletion', 'update'] as const) {
      const h = harness()
      h.setCounts({ [family]: 1 })
      await expect(h.gate.assertScopeRecovered(h.lease, scope))
        .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    }
  })

  it('dispatches exactly one recoverer and verifies the final integrity state', async () => {
    const h = harness()
    h.setCounts({ update: 1 })
    await expect(h.gate.recoverScope(h.lease, scope)).resolves.toEqual({
      recovered: 'update', operations: 1,
    })
    expect(h.recoverUpdate).toHaveBeenCalledOnce()
    expect(h.recoverPublication).not.toHaveBeenCalled()
    expect(h.recoverDeletion).not.toHaveBeenCalled()
    await expect(h.gate.assertScopeRecovered(h.lease, scope)).resolves.toBeUndefined()
  })

  it('fails closed instead of guessing an order for impossible concurrent mutation WALs', async () => {
    const h = harness()
    h.setCounts({ publication: 1, deletion: 1 })
    await expect(h.gate.recoverScope(h.lease, scope))
      .rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' })
    expect(h.recoverPublication).not.toHaveBeenCalled()
    expect(h.recoverDeletion).not.toHaveBeenCalled()
  })

  it('rejects corrupted final state and a foreign project lease', async () => {
    const h = harness()
    h.setIntegrity(false)
    await expect(h.gate.assertScopeRecovered(h.lease, scope))
      .rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(h.gate.assertScopeRecovered(h.lease, {
      kind: 'project', scopeId: 'project:project-b', projectId: 'project-b',
    })).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })
})

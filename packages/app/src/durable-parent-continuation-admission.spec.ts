import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedWorkBinding } from '@aisy/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  captureDurableParentContinuationWithOrphanRecovery,
  durableParentFailedTurnReceiptHash,
  retireDurableParentFailedTurn,
} from './durable-parent-continuation-admission.js'
import {
  durableParentContinuationWorkBindingHash,
  makeNodeDurableParentContinuationStore,
  type DurableParentContinuationIdentityV1,
} from './durable-parent-continuation.js'

const roots: string[] = []
const binding: ResolvedWorkBinding = Object.freeze({
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'workspace',
})

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-parent-admission-')))
  chmodSync(value, 0o700)
  roots.push(value)
  return value
}

function identity(turnId: string, supervisor = 'a'): DurableParentContinuationIdentityV1 {
  return Object.freeze({
    binding,
    workBindingHash: durableParentContinuationWorkBindingHash(binding),
    sessionId: binding.sessionId,
    turnId,
    turnTs: '2026-08-28T12:00:00.000Z',
    supervisorBindingHash: supervisor.repeat(64),
    policyRevision: 'durable-parent-continuation-v1',
    spans: Object.freeze([
      Object.freeze({ role: 'user' as const, provenance: 'operator' as const, text: 'эй' }),
    ]),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('durable parent continuation admission recovery', () => {
  it('AC-19-44 retires a proven non-ambiguous orphan and admits the fresh turn', () => {
    const store = makeNodeDurableParentContinuationStore({
      path: join(root(), 'parent-continuation.json'),
    })
    const stale = store.capture({ ownerId: 'owner-old', identity: identity('turn-old') })
    if (stale.kind !== 'captured') throw new Error('fixture capture failed')
    const canRetireOrphan = vi.fn(() => true)

    const admitted = captureDurableParentContinuationWithOrphanRecovery({
      store,
      capture: { ownerId: 'owner-new', identity: identity('turn-new', 'b') },
      canRetireOrphan,
    })

    expect(canRetireOrphan).toHaveBeenCalledWith(stale.record)
    expect(admitted).toMatchObject({
      kind: 'captured',
      record: { ownerId: 'owner-new', phase: 'active', identity: { turnId: 'turn-new' } },
    })
    expect(durableParentFailedTurnReceiptHash(stale.record)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('AC-19-44 preserves busy state when runtime proof rejects retirement', () => {
    const store = makeNodeDurableParentContinuationStore({
      path: join(root(), 'parent-continuation.json'),
    })
    store.capture({ ownerId: 'owner-old', identity: identity('turn-old') })

    expect(captureDurableParentContinuationWithOrphanRecovery({
      store,
      capture: { ownerId: 'owner-new', identity: identity('turn-new', 'b') },
      canRetireOrphan: () => false,
    })).toMatchObject({ kind: 'busy', turnId: 'turn-old' })
    expect(store.load()).toMatchObject({
      status: 'ready', record: { ownerId: 'owner-old', phase: 'active' },
    })
  })

  it('AC-19-44 publishes a code-owned terminal receipt for the exact failed turn', () => {
    const store = makeNodeDurableParentContinuationStore({
      path: join(root(), 'parent-continuation.json'),
    })
    const captured = store.capture({ ownerId: 'owner-old', identity: identity('turn-old') })
    if (captured.kind !== 'captured') throw new Error('fixture capture failed')
    const canRetire = vi.fn(() => true)

    const retired = retireDurableParentFailedTurn({
      store,
      expected: captured.record,
      canRetire,
    })

    expect(canRetire).toHaveBeenCalledWith(captured.record)
    expect(retired).toMatchObject({
      phase: 'terminal',
      revision: captured.record.revision + 1,
      terminalReceiptHash: durableParentFailedTurnReceiptHash(captured.record),
    })
  })

  it('AC-19-44 retires only the exact active record captured by the failing turn', () => {
    const store = makeNodeDurableParentContinuationStore({
      path: join(root(), 'parent-continuation.json'),
    })
    const captured = store.capture({ ownerId: 'owner-old', identity: identity('turn-old') })
    if (captured.kind !== 'captured') throw new Error('fixture capture failed')
    const advanced = store.pause({
      continuationHash: captured.record.continuationHash,
      ownerId: captured.record.ownerId,
      expectedRevision: captured.record.revision,
      request: {
        runRootHash: 'c'.repeat(64),
        taskId: 'task-a',
        controlLogicalSlotHash: 'd'.repeat(64),
        journalLogicalSlotHash: 'e'.repeat(64),
        attempt: 1,
        phase: 'provider',
        ordinal: 1,
        retryClass: 'retry-once',
      },
    })
    const canRetire = vi.fn(() => true)

    expect(() => retireDurableParentFailedTurn({
      store,
      expected: captured.record,
      canRetire,
    })).toThrow('DURABLE_PARENT_CONTINUATION_FAILURE_RETIRE_DENIED')
    expect(canRetire).not.toHaveBeenCalled()
    expect(store.load()).toMatchObject({
      status: 'ready', record: { revision: advanced.revision, phase: 'paused' },
    })
  })

  it('AC-19-44 never asks runtime proof to retire an ambiguous continuation', () => {
    const store = makeNodeDurableParentContinuationStore({
      path: join(root(), 'parent-continuation.json'),
    })
    const captured = store.capture({ ownerId: 'owner-old', identity: identity('turn-old') })
    if (captured.kind !== 'captured') throw new Error('fixture capture failed')
    store.pause({
      continuationHash: captured.record.continuationHash,
      ownerId: captured.record.ownerId,
      expectedRevision: captured.record.revision,
      request: {
        runRootHash: 'c'.repeat(64),
        taskId: 'task-a',
        controlLogicalSlotHash: 'd'.repeat(64),
        journalLogicalSlotHash: 'e'.repeat(64),
        attempt: 1,
        phase: 'provider',
        ordinal: 1,
        retryClass: 'retry-once',
      },
    })
    const canRetireOrphan = vi.fn(() => true)

    expect(captureDurableParentContinuationWithOrphanRecovery({
      store,
      capture: { ownerId: 'owner-new', identity: identity('turn-new', 'b') },
      canRetireOrphan,
    })).toMatchObject({ kind: 'busy', turnId: 'turn-old' })
    expect(canRetireOrphan).not.toHaveBeenCalled()
    expect(store.load()).toMatchObject({ status: 'ready', record: { phase: 'paused' } })
  })
})

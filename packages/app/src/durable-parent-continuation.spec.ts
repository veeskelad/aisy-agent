import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ResolvedWorkBinding } from '@aisy/core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DurableParentContinuationError,
  durableParentAmbiguityOperationHash,
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
  scope: 'session',
})

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'aisy-parent-continuation-')))
  chmodSync(value, 0o700)
  roots.push(value)
  return value
}

function identity(
  overrides: Partial<DurableParentContinuationIdentityV1> = {},
): DurableParentContinuationIdentityV1 {
  return {
    binding,
    workBindingHash: durableParentContinuationWorkBindingHash(binding),
    sessionId: binding.sessionId,
    turnId: 'telegram:42:turn-a',
    turnTs: '2026-08-13T10:00:00.000Z',
    supervisorBindingHash: 'a'.repeat(64),
    policyRevision: 'durable-parent-continuation-v1',
    spans: Object.freeze([
      Object.freeze({ role: 'system' as const, provenance: 'operator' as const, text: 'Отвечай по-русски.' }),
      Object.freeze({ role: 'user' as const, provenance: 'operator' as const, text: 'Продолжай точный ход.' }),
    ]),
    ...overrides,
  }
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('durable parent continuation store', () => {
  it('captures exact private spans before replay and keeps the file private', () => {
    const directory = root()
    const path = join(directory, 'parent-continuation.json')
    const store = makeNodeDurableParentContinuationStore({ path })

    const captured = store.capture({ ownerId: 'owner-a', identity: identity() })

    expect(captured.kind).toBe('captured')
    if (captured.kind !== 'captured') throw new Error('capture failed')
    expect(store.load()).toEqual({ status: 'ready', record: captured.record })
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(captured.record.identity.spans[1]?.text).toBe('Продолжай точный ход.')
  })

  it('replays only the exact continuation and blocks a foreign active turn', () => {
    const store = makeNodeDurableParentContinuationStore({
      path: join(root(), 'parent-continuation.json'),
    })
    const first = store.capture({ ownerId: 'owner-a', identity: identity() })
    const replay = store.capture({ ownerId: 'owner-b', identity: identity() })
    const busy = store.capture({
      ownerId: 'owner-c',
      identity: identity({ turnId: 'telegram:42:turn-b' }),
    })

    expect(first.kind).toBe('captured')
    expect(replay).toMatchObject({ kind: 'replayed', record: { ownerId: 'owner-a', revision: 1 } })
    expect(busy).toMatchObject({
      kind: 'busy', sessionId: binding.sessionId, turnId: 'telegram:42:turn-a',
    })
  })

  it('retires by exact CAS, replays the terminal receipt and then admits a new turn', () => {
    const store = makeNodeDurableParentContinuationStore({
      path: join(root(), 'parent-continuation.json'),
    })
    const captured = store.capture({ ownerId: 'owner-a', identity: identity() })
    if (captured.kind !== 'captured') throw new Error('capture failed')

    expect(() => store.retire({
      continuationHash: captured.record.continuationHash,
      ownerId: 'owner-b',
      expectedRevision: 1,
      terminalReceiptHash: 'b'.repeat(64),
    })).toThrowError(new DurableParentContinuationError(
      'DURABLE_PARENT_CONTINUATION_TRANSITION_DENIED',
    ))

    const terminal = store.retire({
      continuationHash: captured.record.continuationHash,
      ownerId: 'owner-a',
      expectedRevision: 1,
      terminalReceiptHash: 'b'.repeat(64),
    })
    expect(terminal).toMatchObject({ phase: 'terminal', revision: 2 })
    expect(store.capture({ ownerId: 'owner-z', identity: identity() }))
      .toMatchObject({ kind: 'terminal-replay', record: { terminalReceiptHash: 'b'.repeat(64) } })
    expect(store.capture({
      ownerId: 'owner-c',
      identity: identity({ turnId: 'telegram:42:turn-b' }),
    })).toMatchObject({ kind: 'captured', record: { ownerId: 'owner-c', revision: 1 } })
  })

  it('persists exact ambiguity metadata and resumes only the matching operation', () => {
    const path = join(root(), 'parent-continuation.json')
    const first = makeNodeDurableParentContinuationStore({ path })
    const captured = first.capture({ ownerId: 'owner-a', identity: identity() })
    if (captured.kind !== 'captured') throw new Error('capture failed')
    const request = Object.freeze({
      runRootHash: 'd'.repeat(64),
      taskId: 'review',
      controlLogicalSlotHash: 'e'.repeat(64),
      journalLogicalSlotHash: 'f'.repeat(64),
      attempt: 1 as const,
      phase: 'provider' as const,
      ordinal: 1,
      retryClass: 'retry-once' as const,
    })
    const paused = first.pause({
      continuationHash: captured.record.continuationHash,
      ownerId: captured.record.ownerId,
      expectedRevision: captured.record.revision,
      request,
    })
    expect(paused).toMatchObject({
      phase: 'paused',
      revision: 2,
      ambiguity: { ...request, operationHash: durableParentAmbiguityOperationHash(request) },
    })

    const replacement = makeNodeDurableParentContinuationStore({ path })
    expect(replacement.load()).toEqual({ status: 'ready', record: paused })
    expect(() => replacement.resume({
      continuationHash: paused.continuationHash,
      ownerId: paused.ownerId,
      expectedRevision: paused.revision,
      operationHash: '0'.repeat(64),
    })).toThrowError('DURABLE_PARENT_CONTINUATION_TRANSITION_DENIED')
    const resumed = replacement.resume({
      continuationHash: paused.continuationHash,
      ownerId: paused.ownerId,
      expectedRevision: paused.revision,
      operationHash: paused.ambiguity!.operationHash,
    })
    expect(resumed).toMatchObject({ phase: 'active', revision: 3 })
    expect(resumed.ambiguity).toEqual(paused.ambiguity)
  })

  it('persists cancellation proof before publishing a terminal cancellation', () => {
    const path = join(root(), 'parent-continuation.json')
    const store = makeNodeDurableParentContinuationStore({ path })
    const captured = store.capture({ ownerId: 'owner-a', identity: identity() })
    if (captured.kind !== 'captured') throw new Error('capture failed')
    const request = Object.freeze({
      runRootHash: 'd'.repeat(64),
      taskId: 'review',
      controlLogicalSlotHash: 'e'.repeat(64),
      journalLogicalSlotHash: 'f'.repeat(64),
      attempt: 1 as const,
      phase: 'provider' as const,
      ordinal: 1,
      retryClass: 'retry-once' as const,
    })
    const paused = store.pause({
      continuationHash: captured.record.continuationHash,
      ownerId: captured.record.ownerId,
      expectedRevision: captured.record.revision,
      request,
    })
    const receiptHash = '9'.repeat(64)
    const cancelling = store.beginCancellation({
      continuationHash: paused.continuationHash,
      ownerId: paused.ownerId,
      expectedRevision: paused.revision,
      operationHash: paused.ambiguity!.operationHash,
      cancellationReceiptHash: receiptHash,
    })
    expect(cancelling).toMatchObject({
      phase: 'cancelling', revision: 3, cancellationReceiptHash: receiptHash,
    })
    expect(() => store.finishCancellation({
      continuationHash: cancelling.continuationHash,
      ownerId: cancelling.ownerId,
      expectedRevision: cancelling.revision,
      operationHash: '0'.repeat(64),
      cancellationReceiptHash: receiptHash,
    })).toThrowError('DURABLE_PARENT_CONTINUATION_TRANSITION_DENIED')

    const replacement = makeNodeDurableParentContinuationStore({ path })
    const terminal = replacement.finishCancellation({
      continuationHash: cancelling.continuationHash,
      ownerId: cancelling.ownerId,
      expectedRevision: cancelling.revision,
      operationHash: cancelling.ambiguity!.operationHash,
      cancellationReceiptHash: receiptHash,
    })
    expect(terminal).toMatchObject({
      phase: 'terminal', revision: 4, ambiguity: cancelling.ambiguity,
      cancellationReceiptHash: receiptHash, terminalReceiptHash: receiptHash,
    })
  })

  it('rejects drifted work binding, unbounded payloads and accessor objects', () => {
    const store = makeNodeDurableParentContinuationStore({
      path: join(root(), 'parent-continuation.json'),
    })
    expect(() => store.capture({
      ownerId: 'owner-a',
      identity: identity({ workBindingHash: 'c'.repeat(64) }),
    })).toThrowError('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
    expect(() => store.capture({
      ownerId: 'owner-a',
      identity: identity({
        spans: [{ role: 'user', provenance: 'operator', text: 'x'.repeat(97 * 1024) }],
      }),
    })).toThrowError('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
    expect(() => store.capture(Object.defineProperty({}, 'ownerId', {
      enumerable: true,
      get: () => 'owner-a',
    }) as never)).toThrowError('DURABLE_PARENT_CONTINUATION_INPUT_INVALID')
  })

  it('quarantines checksum tampering and refuses a symlink target', () => {
    const directory = root()
    const path = join(directory, 'parent-continuation.json')
    const store = makeNodeDurableParentContinuationStore({ path })
    store.capture({ ownerId: 'owner-a', identity: identity() })
    const encoded = readFileSync(path, 'utf8')
    writeFileSync(path, encoded.replace('owner-a', 'owner-z'), { encoding: 'utf8', mode: 0o600 })
    expect(store.load()).toEqual({
      status: 'quarantined', reason: 'corrupt-or-unsafe-continuation',
    })

    const target = join(directory, 'target.json')
    const linked = join(directory, 'linked.json')
    writeFileSync(target, '{}\n', { mode: 0o600 })
    symlinkSync(target, linked)
    const linkedStore = makeNodeDurableParentContinuationStore({ path: linked })
    expect(linkedStore.load()).toEqual({
      status: 'quarantined', reason: 'corrupt-or-unsafe-continuation',
    })
    expect(() => linkedStore.capture({ ownerId: 'owner-a', identity: identity() }))
      .toThrowError('DURABLE_PARENT_CONTINUATION_STORE_UNSAFE')
  })
})

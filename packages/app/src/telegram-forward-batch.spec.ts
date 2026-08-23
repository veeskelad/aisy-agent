import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  makeTelegramForwardBatchRuntime,
  fingerprintTelegramForwardUpdate,
  validateTelegramForwardBatchState,
  type TelegramForwardBatchStateV1,
  type TelegramForwardBatchStore,
} from './telegram-forward-batch.js'
import { makeNodeTelegramForwardBatchStore } from './telegram-forward-batch-store.js'

const BINDING = {
  operatorId: 'operator-1',
  profileId: 'default',
  projectId: 'project-a',
  sessionId: 'session-a',
  scope: 'project' as const,
}

function memoryStore(seed?: TelegramForwardBatchStateV1): TelegramForwardBatchStore & {
  value(): TelegramForwardBatchStateV1 | null
} {
  let value = seed === undefined ? null : structuredClone(seed)
  const archived = new Set<string>()
  const archivedUpdates = new Map<number, string>()
  return {
    load: () => value === null ? null : validateTelegramForwardBatchState(structuredClone(value)),
    hasArchived: batchId => archived.has(batchId),
    lookupArchivedUpdate: updateId => archivedUpdates.get(updateId) ?? null,
    save(expected, next) {
      if (expected === null ? value !== null : value?.revision !== expected) throw new Error('conflict')
      value = structuredClone(next)
    },
    archive(expected) {
      if (value?.revision !== expected ||
        (value.status !== 'completed' && value.status !== 'quarantined')) throw new Error('conflict')
      if (value.status === 'completed') {
        archived.add(value.batchId)
        for (const entry of value.order) {
          const item = entry.kind === 'forward'
            ? value.items.find(candidate => candidate.updateId === entry.updateId)
            : value.instructions.find(candidate => candidate.updateId === entry.updateId)
          if (!item) throw new Error('corrupt')
          archivedUpdates.set(entry.updateId, fingerprintTelegramForwardUpdate({
            kind: entry.kind,
            binding: value.binding,
            value: item,
          }))
        }
      }
      value = null
    },
    value: () => value === null ? null : structuredClone(value),
  }
}

function forwarded(updateId: number, text = `forward-${updateId}`) {
  return {
    updateId,
    messageId: updateId + 100,
    unixSeconds: 1_785_000_000 + updateId,
    text,
    sourceRef: 'forward:channel:-1001',
  }
}

describe('Telegram forward batch runtime', () => {
  it('coalesces five forwards after a quiet window into one ordered untrusted request', async () => {
    const store = memoryStore()
    let now = 1_000
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 500,
    })

    for (let id = 1; id <= 5; id++) {
      await expect(runtime.acceptForward(forwarded(id))).resolves.toMatchObject({
        kind: 'accepted',
        state: { items: expect.any(Array) },
      })
      now += 100
    }
    expect(store.value()?.items).toHaveLength(5)
    await expect(runtime.flushIfDue(async () => {})).resolves.toEqual({ kind: 'not-due' })
    now += 500

    const dispatched: unknown[] = []
    await expect(runtime.flushIfDue(async input => { dispatched.push(input) }))
      .resolves.toEqual({ kind: 'completed', count: 5 })
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({
      binding: BINDING,
      spans: [
        { text: 'forward-1', provenance: 'untrusted' },
        { text: 'forward-2', provenance: 'untrusted' },
        { text: 'forward-3', provenance: 'untrusted' },
        { text: 'forward-4', provenance: 'untrusted' },
        { text: 'forward-5', provenance: 'untrusted' },
        { provenance: 'operator' },
      ],
      sources: [
        { updateId: 1 }, { updateId: 2 }, { updateId: 3 }, { updateId: 4 }, { updateId: 5 },
      ],
    })
    expect(store.value()).toBeNull()
    await expect(runtime.acceptForward(forwarded(1))).resolves.toEqual({ kind: 'consumed' })
  })

  it('attaches typed instructions to the exact batch without upgrading forwarded provenance', async () => {
    const store = memoryStore()
    let now = 1_000
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 250,
    })
    await runtime.acceptForward(forwarded(1, 'client text'))
    await runtime.attachInstruction({
      updateId: 2,
      messageId: 102,
      unixSeconds: 1_785_000_002,
      text: 'Предложи ответ',
    })
    now += 300
    let seen: unknown
    await runtime.flushIfDue(async input => { seen = input })

    expect(seen).toMatchObject({
      spans: [
        { text: 'client text', provenance: 'untrusted' },
        { text: 'Предложи ответ', provenance: 'operator' },
      ],
      sources: [{ updateId: 1 }, { updateId: 2 }],
    })
  })

  it('preserves the global Telegram order across forwards and typed instructions', async () => {
    const store = memoryStore()
    let now = 1_000
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 250,
    })
    await runtime.acceptForward(forwarded(1, 'first forward'))
    await runtime.attachInstruction({
      updateId: 2,
      messageId: 102,
      unixSeconds: 1_785_000_002,
      text: 'instruction between messages',
    })
    await runtime.acceptForward(forwarded(3, 'second forward'))
    now += 300

    let seen: unknown
    await runtime.flushIfDue(async input => { seen = input })
    expect(seen).toMatchObject({
      spans: [
        { text: 'first forward', provenance: 'untrusted' },
        { text: 'instruction between messages', provenance: 'operator' },
        { text: 'second forward', provenance: 'untrusted' },
      ],
      sources: [{ updateId: 1 }, { updateId: 2 }, { updateId: 3 }],
    })
  })

  it('deduplicates an exact Telegram retry and quarantines changed retry bytes', async () => {
    const store = memoryStore()
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => 1_000,
      quietMs: 250,
    })
    await expect(runtime.acceptForward(forwarded(1))).resolves.toMatchObject({ kind: 'accepted' })
    await expect(runtime.acceptForward(forwarded(1))).resolves.toMatchObject({ kind: 'duplicate' })
    expect(store.value()?.items).toHaveLength(1)
    await expect(runtime.acceptForward(forwarded(1, 'tampered'))).resolves.toEqual({
      kind: 'blocked',
      code: 'RECOVERY_REQUIRED',
    })
    expect(store.value()).toMatchObject({ status: 'quarantined' })
  })

  it('quarantines a cross-kind retry that reuses an active Telegram update id', async () => {
    const store = memoryStore()
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => 1_000,
      quietMs: 250,
    })
    await runtime.acceptForward(forwarded(1))
    await expect(runtime.attachInstruction({
      updateId: 1,
      messageId: 101,
      unixSeconds: 1_785_000_001,
      text: 'same update, another kind',
    })).resolves.toEqual({ kind: 'blocked', code: 'RECOVERY_REQUIRED' })
    expect(store.value()).toMatchObject({
      status: 'quarantined',
      failureCode: 'DISPATCH_INTERRUPTED',
    })
  })

  it('deduplicates every archived member and rejects changed bytes after completion', async () => {
    const store = memoryStore()
    let now = 1_000
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 250,
    })
    await runtime.acceptForward(forwarded(1))
    await runtime.acceptForward(forwarded(2))
    now += 300
    await runtime.flushIfDue(async () => {})

    await expect(runtime.acceptForward(forwarded(2))).resolves.toEqual({ kind: 'consumed' })
    await expect(runtime.acceptForward(forwarded(2, 'changed bytes'))).resolves.toEqual({ kind: 'tampered' })
  })

  it('pins the first work binding and blocks a project switch before dispatch', async () => {
    const store = memoryStore()
    let binding = { ...BINDING }
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => binding,
      nowMs: () => 1_000,
      quietMs: 250,
    })
    await runtime.acceptForward(forwarded(1))
    binding = { ...BINDING, projectId: 'project-b' }
    await expect(runtime.acceptForward(forwarded(2))).resolves.toEqual({
      kind: 'blocked',
      code: 'BINDING_CHANGED',
    })
    expect(store.value()).toMatchObject({ status: 'quarantined', failureCode: 'BINDING_CHANGED' })
  })

  it('keeps a failed or interrupted dispatch quarantined and never auto-replays it', async () => {
    const store = memoryStore()
    let now = 1_000
    const first = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 250,
    })
    await first.acceptForward(forwarded(1))
    now += 300
    await expect(first.flushIfDue(async () => { throw new Error('raw provider detail') }))
      .resolves.toEqual({ kind: 'failed', code: 'DISPATCH_FAILED' })

    const restarted = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 250,
    })
    await expect(restarted.recover()).resolves.toMatchObject({
      status: 'quarantined',
      failureCode: 'DISPATCH_FAILED',
    })
    let calls = 0
    await expect(restarted.flushIfDue(async () => { calls++ }))
      .resolves.toEqual({ kind: 'recovery-required' })
    expect(calls).toBe(0)
    expect(JSON.stringify(store.value())).not.toContain('raw provider detail')
  })

  it('does not mark a dismissed quarantine as consumed, so an exact resend is possible', async () => {
    const store = memoryStore()
    let now = 1_000
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 250,
    })
    await runtime.acceptForward(forwarded(1))
    now += 300
    await runtime.flushIfDue(async () => { throw new Error('failed') })
    await expect(runtime.dismissQuarantined()).resolves.toBe(true)
    await expect(runtime.acceptForward(forwarded(1))).resolves.toMatchObject({ kind: 'accepted' })
  })

  it('bounds extra operator instructions without discarding the durable batch', async () => {
    const store = memoryStore()
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => 1_000,
      quietMs: 250,
    })
    await runtime.acceptForward(forwarded(1))
    for (let id = 2; id <= 11; id++) {
      await expect(runtime.attachInstruction({
        updateId: id,
        messageId: id + 100,
        unixSeconds: 1_785_000_000 + id,
        text: `instruction-${id}`,
      })).resolves.toMatchObject({ kind: 'attached' })
    }
    await expect(runtime.attachInstruction({
      updateId: 12,
      messageId: 112,
      unixSeconds: 1_785_000_012,
      text: 'one too many',
    })).resolves.toEqual({ kind: 'capped', count: 10 })
    expect(store.value()).toMatchObject({ status: 'collecting' })
    expect(store.value()?.instructions).toHaveLength(10)
  })

  it('rejects runtime item limits above the fixed safety ceiling', () => {
    expect(() => makeTelegramForwardBatchRuntime({
      store: memoryStore(),
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => 1_000,
      quietMs: 250,
      maxItems: 51,
    })).toThrow('FORWARD_BATCH_CONFIG_INVALID')
  })

  it('rejects persisted state with more than fifty forwarded items', async () => {
    const store = memoryStore()
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => 1_000,
      quietMs: 250,
    })
    await runtime.acceptForward(forwarded(1))
    const valid = store.value()!
    const items = Array.from({ length: 51 }, (_, index) => forwarded(index + 1))
    expect(() => validateTelegramForwardBatchState({
      ...valid,
      items,
      order: items.map(item => ({ kind: 'forward', updateId: item.updateId })),
    })).toThrow('FORWARD_BATCH_STORE_CORRUPT')
  })
})

describe('Node Telegram forward batch store', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('persists private state across restart, enforces CAS, and archives completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-forward-batch-'))
    roots.push(root)
    const path = join(root, 'pending.json')
    const firstStore = makeNodeTelegramForwardBatchStore({ path })
    let now = 1_000
    const first = makeTelegramForwardBatchRuntime({
      store: firstStore,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 250,
    })
    await first.acceptForward(forwarded(1))
    expect(statSync(path).mode & 0o777).toBe(0o600)

    const restartedStore = makeNodeTelegramForwardBatchStore({ path })
    expect(restartedStore.load()).toMatchObject({ items: [{ updateId: 1 }], revision: 1 })
    expect(() => restartedStore.save(null, restartedStore.load()!)).toThrow('FORWARD_BATCH_STORE_CONFLICT')

    const restarted = makeTelegramForwardBatchRuntime({
      store: restartedStore,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 250,
    })
    now += 300
    await expect(restarted.flushIfDue(async () => {})).resolves.toEqual({
      kind: 'completed',
      count: 1,
    })
    expect(restartedStore.load()).toBeNull()
  })

  it('persists exact dedupe markers for every completed member', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-forward-batch-'))
    roots.push(root)
    const path = join(root, 'pending.json')
    const store = makeNodeTelegramForwardBatchStore({ path })
    let now = 1_000
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 250,
    })
    await runtime.acceptForward(forwarded(1))
    await runtime.acceptForward(forwarded(2))
    now += 300
    await runtime.flushIfDue(async () => {})

    const restarted = makeTelegramForwardBatchRuntime({
      store: makeNodeTelegramForwardBatchStore({ path }),
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => now,
      quietMs: 250,
    })
    await expect(restarted.acceptForward(forwarded(2))).resolves.toEqual({ kind: 'consumed' })
    await expect(restarted.acceptForward(forwarded(2, 'changed'))).resolves.toEqual({ kind: 'tampered' })
  })

  it('fails closed when another process owns the mutation lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-forward-batch-'))
    roots.push(root)
    const path = join(root, 'pending.json')
    const store = makeNodeTelegramForwardBatchStore({ path })
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => 1_000,
      quietMs: 250,
    })
    writeFileSync(path + '.mutation.lock', 'other-owner', { encoding: 'utf8', mode: 0o600 })
    await expect(runtime.acceptForward(forwarded(1))).rejects.toThrow('FORWARD_BATCH_STORE_LOCKED')
    expect(store.load()).toBeNull()
  })

  it('rejects checksum tampering without exposing file contents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aisy-forward-batch-'))
    roots.push(root)
    const path = join(root, 'pending.json')
    const store = makeNodeTelegramForwardBatchStore({ path })
    const runtime = makeTelegramForwardBatchRuntime({
      store,
      captureBinding: async () => ({ ...BINDING }),
      nowMs: () => 1_000,
      quietMs: 250,
    })
    await runtime.acceptForward(forwarded(1, 'sensitive client text'))
    const raw = readFileSync(path, 'utf8').replace('sensitive client text', 'changed')
    writeFileSync(path, raw, { encoding: 'utf8', mode: 0o600 })
    expect(() => store.load()).toThrow('FORWARD_BATCH_STORE_CORRUPT')
    try {
      store.load()
    } catch (error) {
      expect(String(error)).not.toContain('sensitive client text')
    }
  })
})

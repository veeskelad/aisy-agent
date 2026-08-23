import { describe, expect, it, vi } from 'vitest'

import {
  SEMANTIC_EGRESS_DISCLOSURE_HASH,
  SEMANTIC_EGRESS_DISCLOSURE_REVISION,
  semanticEgressOutboxEventId,
  type SemanticEgressOutboxEventV1,
} from './semantic-egress-consent.js'
import {
  makeSemanticEgressOutboxWorker,
  SemanticEgressOutboxWorkerError,
  type SemanticEgressOutboxDeliveryResult,
} from './semantic-egress-outbox-worker.js'

const BASE_AT = Date.parse('2026-08-01T07:00:00.000Z')

function event(input: {
  revision: number
  offsetMs?: number
  kind?: SemanticEgressOutboxEventV1['kind']
}): SemanticEgressOutboxEventV1 {
  const kind = input.kind ?? 'memory.semantic_egress.activated'
  const authorityId = 'authority-1'
  return {
    schemaVersion: 1,
    eventId: semanticEgressOutboxEventId({
      authorityId,
      authorityRevision: input.revision,
      kind,
    }),
    kind,
    operatorId: 'operator-1',
    profileId: 'profile-1',
    purpose: 'memory.semantic-embedding.v1',
    authorityId,
    authorityRevision: input.revision,
    generation: input.revision,
    connectionId: 'connection-1',
    connectionRevision: 'ready-record-7',
    semanticDescriptorId: 'a'.repeat(64),
    disclosureRevision: SEMANTIC_EGRESS_DISCLOSURE_REVISION,
    disclosureHash: SEMANTIC_EGRESS_DISCLOSURE_HASH,
    at: new Date(BASE_AT + (input.offsetMs ?? input.revision)).toISOString(),
  }
}

function harness(input: {
  events?: unknown
  read?: (limit: number) => Promise<unknown>
  delivery?: (event: Readonly<SemanticEgressOutboxEventV1>, signal: AbortSignal) => Promise<unknown>
  ack?: (eventId: string) => Promise<unknown>
  batchSize?: number
  deliveryTimeoutMs?: number
  durableTimeoutMs?: number
} = {}) {
  const events = input.events ?? [event({ revision: 1 })]
  const readOutbox = vi.fn(input.read ?? (async () => structuredClone(events)))
  const ackOutboxHead = vi.fn(input.ack ?? (async () => 'acked'))
  const deliver = vi.fn(input.delivery ?? (async () => ({ status: 'accepted' })))
  const durable = { readOutbox: readOutbox as never, ackOutboxHead: ackOutboxHead as never }
  const sink = { deliver: deliver as never }
  const worker = makeSemanticEgressOutboxWorker({
    durable,
    sink,
    ...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
    ...(input.deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs: input.deliveryTimeoutMs }),
    ...(input.durableTimeoutMs === undefined ? {} : { durableTimeoutMs: input.durableTimeoutMs }),
  })
  return { worker, durable, sink, readOutbox, ackOutboxHead, deliver }
}

describe('semantic egress outbox worker', () => {
  it('delivers and acknowledges a bounded batch strictly in stable order', async () => {
    const events = [
      event({ revision: 1, offsetMs: 1 }),
      event({ revision: 2, offsetMs: 2, kind: 'memory.semantic_egress.degraded' }),
      event({ revision: 3, offsetMs: 3, kind: 'memory.semantic_egress.revoke_started' }),
    ]
    const target = harness({ events, batchSize: 3 })

    await expect(target.worker.run()).resolves.toEqual({
      read: 3, accepted: 3, duplicates: 0, acknowledged: 3,
    })
    expect(target.readOutbox).toHaveBeenCalledWith(3)
    expect(target.deliver.mock.calls.map(call => call[0].eventId))
      .toEqual(events.map(item => item.eventId))
    expect(target.ackOutboxHead.mock.calls.map(call => call[0]))
      .toEqual(events.map(item => item.eventId))
  })

  it('acknowledges an idempotent duplicate exactly like an accepted delivery', async () => {
    const target = harness({
      delivery: async () => ({ status: 'duplicate-exact' } satisfies SemanticEgressOutboxDeliveryResult),
      ack: async () => 'already-acked',
    })

    await expect(target.worker.run()).resolves.toEqual({
      read: 1, accepted: 0, duplicates: 1, acknowledged: 1,
    })
    expect(target.ackOutboxHead).toHaveBeenCalledOnce()
  })

  it('stops on the first delivery failure without acknowledging it or touching later events', async () => {
    const secret = 'private upstream detail'
    const events = [event({ revision: 1 }), event({ revision: 2 }), event({ revision: 3 })]
    const target = harness({
      events,
      delivery: async current => {
        if (current.authorityRevision === 2) throw new Error(secret)
        return { status: 'accepted' }
      },
    })

    const failure = await target.worker.run().catch((error: unknown) => error)
    expect(failure).toEqual(expect.objectContaining({ code: 'DELIVERY_FAILED' }))
    expect(String(failure)).not.toContain(secret)
    expect(target.deliver).toHaveBeenCalledTimes(2)
    expect(target.ackOutboxHead).toHaveBeenCalledTimes(1)
    expect(target.ackOutboxHead).toHaveBeenCalledWith(events[0]!.eventId)
  })

  it('stops on ack failure and safely retries the unacknowledged event as duplicate', async () => {
    let ackAttempt = 0
    let deliveryAttempt = 0
    const target = harness({
      delivery: async () => ({ status: ++deliveryAttempt === 1 ? 'accepted' : 'duplicate-exact' }),
      ack: async () => ++ackAttempt > 1 ? 'acked' : 'not-head',
    })

    await expect(target.worker.run()).rejects.toMatchObject({ code: 'ACK_FAILED' })
    await expect(target.worker.run()).resolves.toEqual({
      read: 1, accepted: 0, duplicates: 1, acknowledged: 1,
    })
    expect(target.deliver).toHaveBeenCalledTimes(2)
    expect(target.ackOutboxHead).toHaveBeenCalledTimes(2)
  })

  it('preserves durable insertion order without re-sorting by event timestamps', async () => {
    const events = [event({ revision: 2, offsetMs: 2 }), event({ revision: 1, offsetMs: 1 })]
    const target = harness({
      events,
    })

    await expect(target.worker.run()).resolves.toMatchObject({ acknowledged: 2 })
    expect(target.deliver.mock.calls.map(call => call[0].eventId))
      .toEqual(events.map(item => item.eventId))
  })

  it('coalesces concurrent runs into one shared serialized pass', async () => {
    let releaseRead!: () => void
    const blocked = new Promise<void>(resolve => { releaseRead = resolve })
    const target = harness()
    target.readOutbox.mockImplementationOnce(async () => {
      await blocked
      return [event({ revision: 1 })]
    })

    const first = target.worker.run()
    const second = target.worker.run()
    expect(second).toBe(first)
    releaseRead()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { read: 1, accepted: 1, duplicates: 0, acknowledged: 1 },
      { read: 1, accepted: 1, duplicates: 0, acknowledged: 1 },
    ])
    expect(target.readOutbox).toHaveBeenCalledOnce()
    expect(target.deliver).toHaveBeenCalledOnce()
  })

  it('times out a signal-ignoring sink, never late-acks, and retries as duplicate-exact', async () => {
    let resolveLate!: (value: { status: 'accepted' }) => void
    let firstSignal: AbortSignal | undefined
    let attempt = 0
    const target = harness({
      deliveryTimeoutMs: 5,
      delivery: async (_current, signal) => {
        attempt += 1
        if (attempt === 1) {
          firstSignal = signal
          return new Promise(resolve => { resolveLate = resolve })
        }
        return { status: 'duplicate-exact' }
      },
    })

    await expect(target.worker.run()).rejects.toMatchObject({ code: 'DELIVERY_TIMEOUT' })
    expect(firstSignal?.aborted).toBe(true)
    expect(target.ackOutboxHead).not.toHaveBeenCalled()
    await expect(target.worker.run()).resolves.toEqual({
      read: 1, accepted: 0, duplicates: 1, acknowledged: 1,
    })
    resolveLate({ status: 'accepted' })
    await Promise.resolve()
    expect(target.ackOutboxHead).toHaveBeenCalledTimes(1)
  })

  it('aborts an owner run with a stable code and stop permanently closes that worker', async () => {
    const alreadyAborted = harness()
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(alreadyAborted.worker.run(preAborted.signal))
      .rejects.toEqual(new SemanticEgressOutboxWorkerError('RUN_ABORTED'))
    expect(alreadyAborted.readOutbox).not.toHaveBeenCalled()

    let deliverySignal: AbortSignal | undefined
    let resolveDelivery!: (value: { status: 'accepted' }) => void
    const target = harness({
      delivery: async (_current, signal) => {
        deliverySignal = signal
        return new Promise(resolve => { resolveDelivery = resolve })
      },
    })
    const external = new AbortController()
    const running = target.worker.run(external.signal)
    await vi.waitFor(() => expect(target.deliver).toHaveBeenCalledOnce())
    external.abort(new Error('private caller reason'))

    await expect(running).rejects.toEqual(new SemanticEgressOutboxWorkerError('RUN_ABORTED'))
    expect(deliverySignal?.aborted).toBe(true)
    expect(target.ackOutboxHead).not.toHaveBeenCalled()
    resolveDelivery({ status: 'accepted' })

    const stopped = harness({
      delivery: async () => new Promise(() => undefined),
    })
    const stoppedRun = stopped.worker.run()
    await vi.waitFor(() => expect(stopped.deliver).toHaveBeenCalledOnce())
    stopped.worker.stop()
    stopped.worker.stop()
    await expect(stoppedRun).rejects.toEqual(new SemanticEgressOutboxWorkerError('STOPPED'))
    await expect(stopped.worker.run()).rejects.toEqual(new SemanticEgressOutboxWorkerError('STOPPED'))
    expect(stopped.ackOutboxHead).not.toHaveBeenCalled()
  })

  it('times out an ambiguous ack and never advances to the next event or trusts its late result', async () => {
    let resolveAck!: (value: 'acked') => void
    const target = harness({
      events: [event({ revision: 1 }), event({ revision: 2 })],
      ack: async () => new Promise(resolve => { resolveAck = resolve }),
      durableTimeoutMs: 5,
    })
    const running = target.worker.run()
    const outcome = running.catch((error: unknown) => error)
    await vi.waitFor(() => expect(target.ackOutboxHead).toHaveBeenCalledOnce())

    expect(await outcome).toEqual(new SemanticEgressOutboxWorkerError('ACK_TIMEOUT'))
    expect(target.deliver).toHaveBeenCalledTimes(1)
    resolveAck('acked')
    await Promise.resolve()
    expect(target.deliver).toHaveBeenCalledTimes(1)
  })

  it('coalesces across worker instances and ignores a joined caller signal and stop', async () => {
    let releaseOwner!: () => void
    const blocked = new Promise<void>(resolve => { releaseOwner = resolve })
    const owner = harness({
      delivery: async () => {
        await blocked
        return { status: 'accepted' }
      },
    })
    const joinedDeliver = vi.fn(async () => ({ status: 'accepted' as const }))
    const joinedWorker = makeSemanticEgressOutboxWorker({
      durable: owner.durable,
      sink: { deliver: joinedDeliver },
    })
    const first = owner.worker.run()
    await vi.waitFor(() => expect(owner.deliver).toHaveBeenCalledOnce())
    const joinedSignal = new AbortController()
    joinedSignal.abort()
    const joined = joinedWorker.run(joinedSignal.signal)
    expect(joined).toBe(first)
    joinedWorker.stop()
    releaseOwner()

    await expect(Promise.all([first, joined])).resolves.toEqual([
      { read: 1, accepted: 1, duplicates: 0, acknowledged: 1 },
      { read: 1, accepted: 1, duplicates: 0, acknowledged: 1 },
    ])
    expect(joinedDeliver).not.toHaveBeenCalled()
    expect(owner.ackOutboxHead).toHaveBeenCalledOnce()
  })

  it('fails closed on malformed source and sink boundaries with stable redacted errors', async () => {
    const extra = { ...event({ revision: 1 }), content: 'must-not-cross' }
    const malformedSource = harness({ events: [extra] })
    await expect(malformedSource.worker.run())
      .rejects.toEqual(new SemanticEgressOutboxWorkerError('INVALID_EVENT'))
    expect(malformedSource.deliver).not.toHaveBeenCalled()

    const forgedId = { ...event({ revision: 1 }), eventId: 'f'.repeat(64) }
    const forgedSource = harness({ events: [forgedId] })
    await expect(forgedSource.worker.run())
      .rejects.toEqual(new SemanticEgressOutboxWorkerError('INVALID_EVENT'))
    expect(forgedSource.deliver).not.toHaveBeenCalled()

    const malformedSink = harness({ delivery: async () => ({ status: 'accepted', extra: true }) })
    await expect(malformedSink.worker.run())
      .rejects.toEqual(new SemanticEgressOutboxWorkerError('DELIVERY_FAILED'))
    expect(malformedSink.ackOutboxHead).not.toHaveBeenCalled()

    const malformedAck = harness({ ack: async () => true })
    await expect(malformedAck.worker.run())
      .rejects.toEqual(new SemanticEgressOutboxWorkerError('ACK_FAILED'))
  })

  it('redacts durable read failures and never reaches the sink', async () => {
    const secret = 'private sqlite path and statement'
    const target = harness({ read: async () => { throw new Error(secret) } })

    const failure = await target.worker.run().catch((error: unknown) => error)
    expect(failure).toEqual(new SemanticEgressOutboxWorkerError('READ_FAILED'))
    expect(String(failure)).not.toContain(secret)
    expect(target.deliver).not.toHaveBeenCalled()
  })

  it('times out a hung durable read and ignores its late result', async () => {
    let resolveRead!: (value: SemanticEgressOutboxEventV1[]) => void
    const target = harness({
      durableTimeoutMs: 5,
      read: async () => new Promise(resolve => { resolveRead = resolve }),
    })

    await expect(target.worker.run())
      .rejects.toEqual(new SemanticEgressOutboxWorkerError('READ_TIMEOUT'))
    expect(target.deliver).not.toHaveBeenCalled()
    resolveRead([event({ revision: 1 })])
    await Promise.resolve()
    expect(target.deliver).not.toHaveBeenCalled()
  })

  it('rejects invalid bounds and oversized batches without delivery', async () => {
    expect(() => harness({ batchSize: 0 })).toThrowError(
      new SemanticEgressOutboxWorkerError('INVALID_INPUT'),
    )
    expect(() => harness({ deliveryTimeoutMs: 0 })).toThrowError(
      new SemanticEgressOutboxWorkerError('INVALID_INPUT'),
    )
    expect(() => harness({ durableTimeoutMs: 0 })).toThrowError(
      new SemanticEgressOutboxWorkerError('INVALID_INPUT'),
    )
    const target = harness({
      events: [event({ revision: 1 }), event({ revision: 2 })],
      batchSize: 1,
    })
    await expect(target.worker.run()).rejects.toMatchObject({ code: 'INVALID_EVENT' })
    expect(target.deliver).not.toHaveBeenCalled()
  })
})

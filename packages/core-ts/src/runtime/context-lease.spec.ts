import { describe, expect, it } from 'vitest'
import {
  ContextLeaseError,
  makeContextLeaseCoordinator,
  type TurnContextLease,
} from './context-lease.js'

const CONTEXT = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  projectKind: 'project' as const,
  sessionId: 'session-a',
  root: '/Users/operator/projects/a',
  generation: 3,
}

function setup() {
  let id = 0
  const events: Array<{ kind: string; leaseId: string; operationId?: string }> = []
  const coordinator = makeContextLeaseCoordinator({
    newId: () => `id-${++id}`,
    emit: (event) => events.push(event),
  })
  return { coordinator, events }
}

describe('ContextLeaseCoordinator', () => {
  it('acquires an immutable turn context and exposes identifier-only state', () => {
    const { coordinator, events } = setup()
    const lease = coordinator.acquire(CONTEXT)

    expect(lease).toEqual({ ...CONTEXT, leaseId: 'id-1' })
    expect(Object.isFrozen(lease)).toBe(true)
    expect(coordinator.status(lease)).toBe('active')
    expect(events).toEqual([{
      kind: 'context.lease_acquired',
      leaseId: 'id-1',
      projectId: 'project-a',
      sessionId: 'session-a',
      generation: 3,
    }])
  })

  it('quiesce blocks new/reserved I/O and closes after operations drain', async () => {
    const { coordinator } = setup()
    const lease = coordinator.acquire(CONTEXT)
    const reserved = coordinator.reserveOperation(lease)
    const closing = coordinator.quiesceAndClose(lease)

    expect(coordinator.status(lease)).toBe('cancelling')
    expect(coordinator.signal(lease).aborted).toBe(true)
    expect(() => coordinator.reserveOperation(lease)).toThrowError(
      expect.objectContaining({ code: 'STALE_CONTEXT' }),
    )
    expect(() => reserved.beginIo()).toThrowError(expect.objectContaining({ code: 'STALE_CONTEXT' }))

    reserved.complete()
    await closing
    expect(coordinator.status(lease)).toBe('closed')
  })

  it('lets already-started atomic I/O finish while switch waits for drain', async () => {
    const { coordinator } = setup()
    const lease = coordinator.acquire(CONTEXT)
    const operation = coordinator.reserveOperation(lease)
    operation.beginIo()
    let closed = false
    const closing = coordinator.quiesceAndClose(lease).then(() => { closed = true })

    await Promise.resolve()
    expect(closed).toBe(false)
    operation.complete()
    await closing

    expect(closed).toBe(true)
    expect(coordinator.status(lease)).toBe('closed')
  })

  it('rejects forged or mutated lease fields even when leaseId is known', () => {
    const { coordinator } = setup()
    const lease = coordinator.acquire(CONTEXT)
    const forged: TurnContextLease = { ...lease, projectId: 'project-b' }

    expect(() => coordinator.reserveOperation(forged)).toThrow(ContextLeaseError)
    expect(() => coordinator.status({ ...lease, generation: 4 })).toThrowError(
      expect.objectContaining({ code: 'STALE_CONTEXT' }),
    )
  })

  it('closes immediately when no operations are outstanding', async () => {
    const { coordinator } = setup()
    const lease = coordinator.acquire(CONTEXT)

    await coordinator.quiesceAndClose(lease)

    expect(coordinator.status(lease)).toBe('closed')
    expect(() => coordinator.reserveOperation(lease)).toThrowError(
      expect.objectContaining({ code: 'STALE_CONTEXT' }),
    )
  })
})

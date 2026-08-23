import { describe, expect, it } from 'vitest'
import { ContextLeaseError, makeContextLeaseCoordinator } from './context-lease.js'
import {
  ConfinementError,
  makeConfinementPort,
  type ConfinementEvent,
  type ConfinementWorkerRequest,
} from './confinement.js'

const CONTEXT = {
  operatorId: 'telegram:42',
  profileId: 'default',
  projectId: 'project-a',
  projectKind: 'project' as const,
  sessionId: 'session-a',
  root: '/Users/operator/projects/a',
  generation: 7,
}

function setup(run: (request: ConfinementWorkerRequest) => Promise<unknown>) {
  let leaseId = 0
  let requestId = 0
  const events: ConfinementEvent[] = []
  const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
  const lease = leases.acquire(CONTEXT)
  const confinement = makeConfinementPort({
    leases,
    process: { run },
    newId: () => `request-${++requestId}`,
    emit: (event) => events.push(event),
  })
  return { leases, lease, confinement, events }
}

function success(request: ConfinementWorkerRequest, data: object): object {
  return { version: 1, requestId: request.requestId, ok: true, data }
}

describe('ConfinementPort', () => {
  it('derives the worker root only from the immutable lease', async () => {
    const requests: ConfinementWorkerRequest[] = []
    const { confinement, lease } = setup(async (request) => {
      requests.push(request)
      if (request.op === 'read') return success(request, { text: 'Привет', bytes: 12 })
      if (request.op === 'write') return success(request, { bytes: 12 })
      if (request.op === 'edit') return success(request, { bytes: 12, replacements: 1 })
      if (request.op === 'list') return success(request, { entries: ['a.txt', 'каталог'] })
      return success(request, { entries: 2, files: 1, directories: 1, totalBytes: 12 })
    })

    await expect(confinement.readText(lease, 'a.txt')).resolves.toBe('Привет')
    await expect(confinement.writeText(lease, 'b.txt', 'готово')).resolves.toBe(12)
    await expect(confinement.editText(lease, 'b.txt', 'старое', 'готово')).resolves.toEqual({
      bytes: 12,
      replacements: 1,
    })
    await expect(confinement.list(lease)).resolves.toEqual(['a.txt', 'каталог'])
    await expect(confinement.scan(lease)).resolves.toEqual({
      entries: 2,
      files: 1,
      directories: 1,
      totalBytes: 12,
    })

    expect(requests).toHaveLength(5)
    expect(requests.every((request) => request.root === CONTEXT.root)).toBe(true)
    expect(requests.map((request) => request.requestId)).toEqual([
      'request-1', 'request-2', 'request-3', 'request-4', 'request-5',
    ])
    expect(requests[2]).toMatchObject({
      op: 'edit',
      path: 'b.txt',
      oldText: 'старое',
      newText: 'готово',
      replaceAll: false,
    })
  })

  it('rejects a forged lease before starting the worker', async () => {
    let calls = 0
    const { confinement, lease } = setup(async () => { calls += 1 })

    await expect(confinement.readText({ ...lease, root: '/tmp/forged' }, 'file.txt'))
      .rejects.toBeInstanceOf(ContextLeaseError)
    expect(calls).toBe(0)
  })

  it('rechecks the lease immediately before process I/O', async () => {
    let calls = 0
    let closing: Promise<void> | undefined
    let leases!: ReturnType<typeof makeContextLeaseCoordinator>
    let lease!: ReturnType<typeof leases.acquire>
    let id = 0
    leases = makeContextLeaseCoordinator({ newId: () => `id-${++id}` })
    lease = leases.acquire(CONTEXT)
    const confinement = makeConfinementPort({
      leases,
      process: { run: async () => { calls += 1 } },
      newId: () => {
        closing = leases.quiesceAndClose(lease)
        return 'request-race'
      },
    })

    await expect(confinement.readText(lease, 'file.txt')).rejects.toMatchObject({
      code: 'STALE_CONTEXT',
    })
    await closing
    expect(calls).toBe(0)
    expect(leases.status(lease)).toBe('closed')
  })

  it('lets atomic I/O finish while quiesce waits for completion', async () => {
    let release!: () => void
    let started!: () => void
    const processStarted = new Promise<void>((resolve) => { started = resolve })
    const processRelease = new Promise<void>((resolve) => { release = resolve })
    const { confinement, lease, leases } = setup(async (request) => {
      started()
      await processRelease
      return success(request, { text: 'ok', bytes: 2 })
    })

    const reading = confinement.readText(lease, 'file.txt')
    await processStarted
    let closed = false
    const closing = leases.quiesceAndClose(lease).then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)

    release()
    await expect(reading).resolves.toBe('ok')
    await closing
    expect(closed).toBe(true)
  })

  it('maps worker denial to a code-only error and identifier-only event', async () => {
    const { confinement, lease, events } = setup(async (request) => ({
      version: 1,
      requestId: request.requestId,
      ok: false,
      error: { code: 'SYMLINK_DENIED' },
    }))

    await expect(confinement.readText(lease, 'private/link'))
      .rejects.toEqual(new ConfinementError('SYMLINK_DENIED'))
    expect(events.at(-1)).toMatchObject({
      kind: 'confinement.denied',
      code: 'SYMLINK_DENIED',
      leaseId: lease.leaseId,
      projectId: lease.projectId,
      sessionId: lease.sessionId,
      generation: lease.generation,
    })
    expect(JSON.stringify(events)).not.toContain('private/link')
  })

  it('redacts process exceptions', async () => {
    const { confinement, lease } = setup(async () => {
      throw new Error('/private/root/credential.txt')
    })

    await expect(confinement.readText(lease, 'file.txt'))
      .rejects.toEqual(new ConfinementError('PROCESS_FAILED'))
  })

  it('redacts request-id generator failures and releases the lease operation', async () => {
    let calls = 0
    let leaseId = 0
    const leases = makeContextLeaseCoordinator({ newId: () => `lease-${++leaseId}` })
    const lease = leases.acquire(CONTEXT)
    const confinement = makeConfinementPort({
      leases,
      process: { run: async () => { calls += 1 } },
      newId: () => { throw new Error('/private/state/request-id') },
    })

    await expect(confinement.readText(lease, 'file.txt'))
      .rejects.toEqual(new ConfinementError('INVALID_REQUEST'))
    expect(calls).toBe(0)
    await expect(leases.quiesceAndClose(lease)).resolves.toBeUndefined()
  })

  it.each([
    { version: 2, requestId: 'request-1', ok: true, data: { text: 'ok', bytes: 2 } },
    { version: 1, requestId: 'wrong', ok: true, data: { text: 'ok', bytes: 2 } },
    { version: 1, requestId: 'request-1', ok: false, error: { code: 'UNKNOWN' } },
    { version: 1, requestId: 'request-1', ok: true, data: { text: 'ok', bytes: 999 } },
    'not-an-object',
  ])('rejects malformed or mismatched worker envelopes', async (response) => {
    const { confinement, lease } = setup(async () => response)
    await expect(confinement.readText(lease, 'file.txt'))
      .rejects.toEqual(new ConfinementError('PROTOCOL_ERROR'))
  })

  it('rejects oversized writes after lease validation and before process I/O', async () => {
    let calls = 0
    const { confinement, lease } = setup(async () => { calls += 1 })
    const oversized = 'x'.repeat(9)

    await expect(confinement.writeText(lease, 'file.txt', oversized, 8))
      .rejects.toEqual(new ConfinementError('LIMIT_EXCEEDED'))
    await expect(confinement.writeText({ ...lease, projectId: 'forged' }, 'file.txt', oversized, 8))
      .rejects.toBeInstanceOf(ContextLeaseError)
    expect(calls).toBe(0)
  })

  it('rejects invalid edit preconditions before process I/O and validates results', async () => {
    let calls = 0
    const invalid = setup(async () => { calls += 1 })

    await expect(invalid.confinement.editText(invalid.lease, 'file.txt', '', 'new'))
      .rejects.toEqual(new ConfinementError('INVALID_REQUEST'))
    await expect(invalid.confinement.editText(
      { ...invalid.lease, projectId: 'forged' },
      'file.txt',
      '',
      'new',
    )).rejects.toBeInstanceOf(ContextLeaseError)
    expect(calls).toBe(0)

    const malformed = setup(async (request) => success(request, {
      bytes: 3,
      replacements: 0,
    }))
    await expect(malformed.confinement.editText(
      malformed.lease,
      'file.txt',
      'old',
      'new',
    )).rejects.toEqual(new ConfinementError('PROTOCOL_ERROR'))
  })

  it('rejects malformed list and scan payloads', async () => {
    const malformedList = setup(async (request) => success(request, { entries: ['../escape'] }))
    await expect(malformedList.confinement.list(malformedList.lease))
      .rejects.toEqual(new ConfinementError('PROTOCOL_ERROR'))

    const malformedScan = setup(async (request) => success(request, {
      entries: 1,
      files: 2,
      directories: 0,
      totalBytes: -1,
    }))
    await expect(malformedScan.confinement.scan(malformedScan.lease))
      .rejects.toEqual(new ConfinementError('PROTOCOL_ERROR'))
  })
})

import { isAbsolute, normalize, parse, resolve } from 'node:path'
import type { WorkContextKind } from './project-registry-v2.js'

export interface TurnContextLease {
  readonly operatorId: string
  readonly profileId: string
  readonly projectId: string
  readonly projectKind: WorkContextKind
  readonly sessionId: string
  readonly root: string
  readonly generation: number
  readonly leaseId: string
}

export type ContextLeaseStatus = 'active' | 'cancelling' | 'closed'

export interface LeaseOperation {
  readonly operationId: string
  beginIo(): void
  complete(): void
}

export interface ContextLeaseEvent {
  kind:
    | 'context.lease_acquired'
    | 'context.lease_cancelling'
    | 'context.lease_closed'
    | 'context.operation_reserved'
    | 'context.operation_started'
    | 'context.operation_completed'
  leaseId: string
  projectId: string
  sessionId: string
  generation: number
  operationId?: string
}

export interface ContextLeaseCoordinator {
  acquire(input: Omit<TurnContextLease, 'leaseId'>): TurnContextLease
  status(lease: TurnContextLease): ContextLeaseStatus
  signal(lease: TurnContextLease): AbortSignal
  reserveOperation(lease: TurnContextLease): LeaseOperation
  quiesceAndClose(lease: TurnContextLease): Promise<void>
}

export class ContextLeaseError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_CONTEXT'
      | 'DUPLICATE_ID'
      | 'CONTEXT_NOT_FOUND'
      | 'STALE_CONTEXT'
      | 'OPERATION_PHASE',
  ) {
    super(code)
    this.name = 'ContextLeaseError'
  }
}

interface OperationRecord {
  phase: 'reserved' | 'io-active'
}

interface LeaseRecord {
  lease: TurnContextLease
  status: ContextLeaseStatus
  abort: AbortController
  operations: Map<string, OperationRecord>
  closeWaiters: Array<() => void>
}

function nonEmpty(value: string): string {
  const result = value.trim()
  if (result.length === 0) throw new ContextLeaseError('INVALID_CONTEXT')
  return result
}

function sameLease(left: TurnContextLease, right: TurnContextLease): boolean {
  return left.leaseId === right.leaseId &&
    left.operatorId === right.operatorId && left.profileId === right.profileId &&
    left.projectId === right.projectId && left.projectKind === right.projectKind &&
    left.sessionId === right.sessionId && left.root === right.root &&
    left.generation === right.generation
}

export function makeContextLeaseCoordinator(deps: {
  newId: () => string
  emit?: (event: ContextLeaseEvent) => void
}): ContextLeaseCoordinator {
  const records = new Map<string, LeaseRecord>()
  const ids = new Set<string>()

  const allocateId = (): string => {
    const id = nonEmpty(deps.newId())
    if (ids.has(id)) throw new ContextLeaseError('DUPLICATE_ID')
    ids.add(id)
    return id
  }

  const recordFor = (lease: TurnContextLease): LeaseRecord => {
    const record = records.get(lease.leaseId)
    if (!record) throw new ContextLeaseError('CONTEXT_NOT_FOUND')
    if (!sameLease(record.lease, lease)) throw new ContextLeaseError('STALE_CONTEXT')
    return record
  }

  const emit = (record: LeaseRecord, kind: ContextLeaseEvent['kind'], operationId?: string): void => {
    deps.emit?.({
      kind,
      leaseId: record.lease.leaseId,
      projectId: record.lease.projectId,
      sessionId: record.lease.sessionId,
      generation: record.lease.generation,
      ...(operationId === undefined ? {} : { operationId }),
    })
  }

  const closeIfDrained = (record: LeaseRecord): void => {
    if (record.status !== 'cancelling' || record.operations.size > 0) return
    record.status = 'closed'
    emit(record, 'context.lease_closed')
    const waiters = record.closeWaiters.splice(0)
    for (const resolveWaiter of waiters) resolveWaiter()
  }

  return {
    acquire(input) {
      if (input.projectKind !== 'workspace' && input.projectKind !== 'project') {
        throw new ContextLeaseError('INVALID_CONTEXT')
      }
      if (!Number.isSafeInteger(input.generation) || input.generation < 1 ||
        !isAbsolute(input.root)) {
        throw new ContextLeaseError('INVALID_CONTEXT')
      }
      const root = normalize(resolve(input.root))
      if (root === parse(root).root) throw new ContextLeaseError('INVALID_CONTEXT')
      const lease = Object.freeze<TurnContextLease>({
        operatorId: nonEmpty(input.operatorId),
        profileId: nonEmpty(input.profileId),
        projectId: nonEmpty(input.projectId),
        projectKind: input.projectKind,
        sessionId: nonEmpty(input.sessionId),
        root,
        generation: input.generation,
        leaseId: allocateId(),
      })
      const record: LeaseRecord = {
        lease,
        status: 'active',
        abort: new AbortController(),
        operations: new Map(),
        closeWaiters: [],
      }
      records.set(lease.leaseId, record)
      emit(record, 'context.lease_acquired')
      return lease
    },

    status(lease) {
      return recordFor(lease).status
    },

    signal(lease) {
      return recordFor(lease).abort.signal
    },

    reserveOperation(lease) {
      const record = recordFor(lease)
      if (record.status !== 'active') throw new ContextLeaseError('STALE_CONTEXT')
      const operationId = allocateId()
      record.operations.set(operationId, { phase: 'reserved' })
      emit(record, 'context.operation_reserved', operationId)
      let completed = false
      return Object.freeze<LeaseOperation>({
        operationId,
        beginIo() {
          if (completed) throw new ContextLeaseError('OPERATION_PHASE')
          const current = recordFor(lease)
          const operation = current.operations.get(operationId)
          if (!operation || operation.phase !== 'reserved') {
            throw new ContextLeaseError('OPERATION_PHASE')
          }
          if (current.status !== 'active') throw new ContextLeaseError('STALE_CONTEXT')
          operation.phase = 'io-active'
          emit(current, 'context.operation_started', operationId)
        },
        complete() {
          if (completed) return
          completed = true
          const current = recordFor(lease)
          if (!current.operations.delete(operationId)) {
            throw new ContextLeaseError('OPERATION_PHASE')
          }
          emit(current, 'context.operation_completed', operationId)
          closeIfDrained(current)
        },
      })
    },

    quiesceAndClose(lease) {
      const record = recordFor(lease)
      if (record.status === 'closed') return Promise.resolve()
      if (record.status === 'active') {
        record.status = 'cancelling'
        record.abort.abort(new ContextLeaseError('STALE_CONTEXT'))
        emit(record, 'context.lease_cancelling')
      }
      if (record.operations.size === 0) {
        closeIfDrained(record)
        return Promise.resolve()
      }
      return new Promise((resolveWaiter) => record.closeWaiters.push(resolveWaiter))
    },
  }
}

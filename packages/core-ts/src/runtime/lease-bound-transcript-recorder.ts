import type { TranscriptRecorder } from '../agent-loop/types.js'
import type { ContextLeaseCoordinator, TurnContextLease } from './context-lease.js'
import type { TranscriptBinding } from './session-transcript.js'

export class TranscriptLeaseBindingError extends Error {
  constructor() {
    super('transcript binding does not match turn context lease')
    this.name = 'TranscriptLeaseBindingError'
  }
}

function sameBinding(lease: TurnContextLease, binding: TranscriptBinding): boolean {
  return lease.operatorId === binding.operatorId && lease.profileId === binding.profileId &&
    lease.projectId === binding.projectId && lease.sessionId === binding.sessionId
}

/**
 * Binds every transcript read/write to one immutable turn lease. An operation
 * that starts before quiesce may drain; a stale operation is rejected before
 * delegate I/O. The wrapper never changes transcript content or authority.
 */
export function makeLeaseBoundTranscriptRecorder(deps: {
  lease: TurnContextLease
  leases: ContextLeaseCoordinator
  binding: TranscriptBinding
  delegate: TranscriptRecorder
}): TranscriptRecorder {
  if (!sameBinding(deps.lease, deps.binding)) throw new TranscriptLeaseBindingError()

  const assertSession = (sessionId: string): void => {
    if (sessionId !== deps.lease.sessionId) throw new TranscriptLeaseBindingError()
  }

  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    const operation = deps.leases.reserveOperation(deps.lease)
    try {
      operation.beginIo()
      return await work()
    } finally {
      operation.complete()
    }
  }

  return {
    start: async input => {
      assertSession(input.sessionId)
      return run(() => deps.delegate.start(input))
    },
    history: async input => {
      assertSession(input.sessionId)
      return run(() => deps.delegate.history(input))
    },
    record: async input => {
      assertSession(input.sessionId)
      return run(() => deps.delegate.record(input))
    },
  }
}

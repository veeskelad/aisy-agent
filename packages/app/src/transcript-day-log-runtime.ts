import {
  makeSessionTranscript,
  projectSessionTranscriptDayLog,
  type ContextLeaseCoordinator,
  type NormalizedDayLog,
  type TranscriptBinding,
  type TurnContextLease,
} from '@aisy/core'
import { makeNodeSessionTranscriptPersistence } from './session-transcript-store.js'

export class TranscriptDayLogSourceError extends Error {
  readonly code = 'TRANSCRIPT_DAY_LOG_UNAVAILABLE'

  constructor() {
    super('TRANSCRIPT_DAY_LOG_UNAVAILABLE')
    this.name = 'TranscriptDayLogSourceError'
  }
}

export interface TranscriptDayLogSource {
  load(date: string): Promise<NormalizedDayLog>
}

function sameBinding(lease: TurnContextLease, binding: TranscriptBinding): boolean {
  return lease.operatorId === binding.operatorId && lease.profileId === binding.profileId &&
    lease.projectId === binding.projectId && lease.sessionId === binding.sessionId
}

/**
 * Builds a lazy, exact-Session nightly source. The caller must supply a real
 * per-Project maintenance lease; this component never widens it to Workspace.
 */
export function makeNodeLeaseBoundTranscriptDayLogSource(input: {
  root: string
  binding: TranscriptBinding
  lease: TurnContextLease
  leases: Pick<ContextLeaseCoordinator, 'reserveOperation'>
  maxRecords?: number
  maxBytes?: number
}): TranscriptDayLogSource {
  const root = input.root
  const binding = Object.freeze<TranscriptBinding>({
    operatorId: input.binding.operatorId,
    profileId: input.binding.profileId,
    projectId: input.binding.projectId,
    sessionId: input.binding.sessionId,
  })
  const lease = input.lease
  const leases = input.leases
  if (!sameBinding(lease, binding)) throw new TranscriptDayLogSourceError()
  const limits = Object.freeze({
    ...(input.maxRecords === undefined ? {} : { maxRecords: input.maxRecords }),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  })
  let transcript: ReturnType<typeof makeSessionTranscript> | undefined

  return {
    async load(date) {
      let operation: ReturnType<typeof leases.reserveOperation> | undefined
      let failed = false
      try {
        operation = leases.reserveOperation(lease)
        operation.beginIo()
        transcript ??= makeSessionTranscript({
          persistence: makeNodeSessionTranscriptPersistence({ root }),
          classifyLoadBearing: () => ({ loadBearing: false, classifierVersion: 'read-only-v1' }),
        })
        const rows = await transcript.read(binding)
        return projectSessionTranscriptDayLog({ binding, date, rows, ...limits })
      } catch {
        failed = true
        throw new TranscriptDayLogSourceError()
      } finally {
        try { operation?.complete() } catch {
          if (!failed) throw new TranscriptDayLogSourceError()
        }
      }
    },
  }
}

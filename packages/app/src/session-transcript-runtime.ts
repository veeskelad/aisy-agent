import {
  makeLeaseBoundTranscriptRecorder,
  makeSessionTranscript,
  makeSessionTranscriptHistoryProjector,
  makeSessionTranscriptRecorder,
  type ContextLeaseCoordinator,
  type TranscriptBinding,
  type TranscriptRecorder,
  type TurnContextLease,
} from '@aisy/core'
import { makeNodeSessionTranscriptPersistence } from './session-transcript-store.js'

export interface NodeSessionTranscriptRuntimeDeps {
  root: string
  binding: TranscriptBinding
  lease: TurnContextLease
  leases: ContextLeaseCoordinator
  budget: { windowTokens: number; compactAtFraction: number }
  classifyLoadBearing: Parameters<typeof makeSessionTranscript>[0]['classifyLoadBearing']
  summarize: Parameters<typeof makeSessionTranscriptHistoryProjector>[0]['summarize']
  estimateTokens: Parameters<typeof makeSessionTranscriptHistoryProjector>[0]['estimateTokens']
  emitEvent?: (event: string, payload: unknown) => void
  /** Writer lease held by this process (ADR-0068); ownership is re-checked before every I/O. */
  writerLease?: { assertOwned(): void }
}

/**
 * Production composition for one immutable turn lease. Creating the component
 * does not touch private storage or activate any transport; callers must
 * explicitly install and invoke the returned recorder in their AgentRunner.
 */
export function makeNodeLeaseBoundSessionTranscriptRecorder(
  deps: NodeSessionTranscriptRuntimeDeps,
): TranscriptRecorder {
  const binding = Object.freeze<TranscriptBinding>({ ...deps.binding })
  const budget = Object.freeze({ ...deps.budget })
  let recorder: TranscriptRecorder | undefined
  const getRecorder = (): TranscriptRecorder => {
    if (recorder !== undefined) return recorder
    const transcript = makeSessionTranscript({
      persistence: makeNodeSessionTranscriptPersistence({
        root: deps.root,
        ...(deps.writerLease === undefined ? {} : { lease: deps.writerLease }),
      }),
      classifyLoadBearing: deps.classifyLoadBearing,
    })
    const historyProjector = makeSessionTranscriptHistoryProjector({
      transcript,
      budget,
      summarize: deps.summarize,
      estimateTokens: deps.estimateTokens,
      ...(deps.emitEvent === undefined ? {} : { emitEvent: deps.emitEvent }),
    })
    recorder = makeSessionTranscriptRecorder({
      transcript,
      binding,
      historyProjector,
    })
    return recorder
  }
  const lazyRecorder: TranscriptRecorder = {
    start: input => getRecorder().start(input),
    history: input => getRecorder().history(input),
    record: input => getRecorder().record(input),
  }
  return makeLeaseBoundTranscriptRecorder({
    lease: deps.lease,
    leases: deps.leases,
    binding,
    delegate: lazyRecorder,
  })
}

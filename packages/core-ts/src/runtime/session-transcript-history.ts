import { makeContextEngine } from '../context-engine/index.js'
import type { TranscriptEntry } from '../context-engine/types.js'
import type { ContextSpan } from '../agent-loop/types.js'
import type {
  SessionTranscript,
  TranscriptBinding,
} from './session-transcript.js'

export interface SessionTranscriptHistoryProjector {
  project(binding: TranscriptBinding): Promise<ContextSpan[]>
}

export class SessionTranscriptHistoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionTranscriptHistoryError'
  }
}

export function makeSessionTranscriptHistoryProjector(deps: {
  transcript: Pick<SessionTranscript, 'manifest' | 'read'>
  budget: { windowTokens: number; compactAtFraction: number }
  summarize(entries: TranscriptEntry[]): Promise<string>
  estimateTokens(text: string): number
  emitEvent?: (event: string, payload: unknown) => void
}): SessionTranscriptHistoryProjector {
  return {
    async project(binding): Promise<ContextSpan[]> {
      const manifest = await deps.transcript.manifest(binding)
      if (manifest.resumeCapability !== 'exact-v2' || manifest.frozenPrefix === null) {
        throw new SessionTranscriptHistoryError('session does not have exact-v2 history authority')
      }
      let prefixText: string
      try {
        prefixText = new TextDecoder('utf-8', { fatal: true }).decode(
          Buffer.from(manifest.frozenPrefix.bytesBase64, 'base64'),
        )
      } catch {
        throw new SessionTranscriptHistoryError('frozen prefix is not valid UTF-8')
      }
      const rows = await deps.transcript.read(binding)
      const entries: TranscriptEntry[] = rows.map(row => ({
        seq: row.sessionSeq,
        role: row.role,
        provenance: row.provenance,
        text: row.content,
        ...(row.loadBearing ? { loadBearing: true } : {}),
      }))
      const engine = makeContextEngine({
        journalAppend() { throw new SessionTranscriptHistoryError('history projector is read-only') },
        journalRead(sessionId) {
          if (sessionId !== binding.sessionId) {
            throw new SessionTranscriptHistoryError('history session binding mismatch')
          }
          return entries.map(entry => ({ ...entry }))
        },
        journalAvailable: () => true,
        pinnedPrefix: () => ({
          text: prefixText,
          breakpoints: [...manifest.frozenPrefix!.breakpoints],
        }),
        budget: { ...deps.budget },
        summarize: deps.summarize,
        estimateTokens: deps.estimateTokens,
        ...(deps.emitEvent === undefined ? {} : { emitEvent: deps.emitEvent }),
      })
      const view = await engine.assemble(binding.sessionId)
      return view.segments
        .filter(segment => segment.kind !== 'pinned')
        .map(segment => ({
          role: segment.role,
          provenance: segment.provenance,
          text: segment.text,
        }))
    },
  }
}

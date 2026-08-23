// Per-turn memory self-check, wired into the live composition (ADR-0078).
//
// The thresholds themselves live in Core and are pure. This is the part that
// knows where the numbers come from in a running installation: the projection
// health observed while reading the frozen prefix, the length of the current
// session, and the operator profile on disk.
//
// Notices go to the operator through the journal. They are never turned into
// context for the model: how full memory is, is a fact about the installation,
// not an instruction to the agent.

import { SESSION_CONSOLIDATION_MESSAGES, memorySelfCheck } from '@aisy/core'
import type { MemoryNotice, MemoryProjectionHealth } from '@aisy/core'

export interface ObservedProjection extends MemoryProjectionHealth {
  truncated: boolean
}

export interface MemorySelfCheckRuntime {
  /** Called by the prefix source every time the projection is read. */
  observeProjection(health: ObservedProjection): void
  /** Runs the check for the current turn and reports what changed. */
  check(input: { sessionMessages: number }): readonly MemoryNotice[]
}

/** Unknown health means silence, not a complaint about a projection never read. */
const UNKNOWN: MemoryProjectionHealth = { bytes: 0, lines: 0, level: 'ok' }

export function makeMemorySelfCheckRuntime(deps: {
  /** Size of the operator profile file; zero when onboarding never happened. */
  operatorProfileBytes: () => number
  emit: (notice: MemoryNotice) => void
  /**
   * Flush the course of the session to the daily journal (ADR-0079). Called by
   * the runtime whenever the session crosses another consolidation threshold —
   * not by the model, which on a long conversation is exactly the participant
   * least likely to remember.
   */
  onConsolidate?: (sessionMessages: number) => void
}): MemorySelfCheckRuntime {
  let projection: MemoryProjectionHealth = UNKNOWN
  let reported = ''
  let flushedAt = 0

  return {
    observeProjection(health) {
      projection = { bytes: health.bytes, lines: health.lines, level: health.level }
    },

    check(input) {
      let profileBytes = 0
      try {
        profileBytes = deps.operatorProfileBytes()
      } catch {
        // An unreadable profile is not an empty profile: staying silent is
        // better than telling the operator to fill in what may already be there.
        profileBytes = 1
      }

      const notices = memorySelfCheck({
        projection,
        sessionMessages: input.sessionMessages,
        operatorProfileBytes: profileBytes,
      })

      if (input.sessionMessages - flushedAt >= SESSION_CONSOLIDATION_MESSAGES) {
        flushedAt = input.sessionMessages
        try {
          deps.onConsolidate?.(input.sessionMessages)
        } catch { /* a full disk must not cost the operator a turn */ }
      }

      // The same state repeated every turn is one situation, not thirty. Only a
      // change is worth the operator's attention.
      const signature = notices.map((notice) => notice.code).join(',')
      if (signature !== reported) {
        reported = signature
        for (const notice of notices) {
          try {
            deps.emit(notice)
          } catch { /* a broken journal must not break the turn */ }
        }
      }

      return notices
    },
  }
}

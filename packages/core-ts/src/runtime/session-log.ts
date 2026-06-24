// packages/core-ts/src/runtime/session-log.ts
// Durable append-only session log: each LogEntry is one JSON line via the
// injected sink (the node bin appends to ~/.aisy/session-log.jsonl). resume()
// returns null — full crash-resume (TurnState replay) is a deferred follow-up;
// this gives a durable, inspectable audit trail today.

import type { SessionLog, SessionSummary, LogEntry } from '../agent-loop/types.js'

export function makeJsonlSessionLog(deps: {
  appendLine: (line: string) => void
  readLines?: () => string[]
}): SessionLog {
  return {
    append: (entry: LogEntry) => deps.appendLine(JSON.stringify(entry)),
    resume: () => null,
    recent: (n: number): SessionSummary[] => {
      const lines = deps.readLines?.() ?? []
      const map = new Map<string, { turns: number; lastAt: string }>()
      for (const line of lines) {
        if (!line.trim()) continue
        let entry: unknown
        try { entry = JSON.parse(line) } catch { continue }
        if (typeof entry !== 'object' || entry === null) continue
        const e = entry as Record<string, unknown>
        // Extract sessionId from payload (the log writes LogEntry; payload carries sessionId)
        const payload = e['payload']
        const sessionId =
          typeof payload === 'object' && payload !== null
            ? (payload as Record<string, unknown>)['sessionId']
            : undefined
        if (typeof sessionId !== 'string') continue
        const ts = typeof e['ts'] === 'string' ? e['ts'] : ''
        const existing = map.get(sessionId)
        if (!existing) {
          map.set(sessionId, { turns: 1, lastAt: ts })
        } else {
          existing.turns += 1
          if (ts > existing.lastAt) existing.lastAt = ts
        }
      }
      return [...map.entries()]
        .map(([sessionId, { turns, lastAt }]) => ({ sessionId, turns, lastAt }))
        .sort((a, b) => (b.lastAt > a.lastAt ? 1 : b.lastAt < a.lastAt ? -1 : 0))
        .slice(0, n)
    },
  }
}

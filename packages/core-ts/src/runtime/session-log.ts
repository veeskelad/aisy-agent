// packages/core-ts/src/runtime/session-log.ts
// Durable append-only session log: each LogEntry is one JSON line via the
// injected sink (the node bin fsyncs ~/.aisy/session-log.jsonl). Exact-turn
// checkpoints restore the plan cursor and tool ordinal high-water after crash.

import type { SessionLog, SessionSummary, LogEntry } from '../agent-loop/types.js'

export function makeJsonlSessionLog(deps: {
  appendLine: (line: string) => void
  readLines?: () => string[]
}): SessionLog {
  const resume = (sessionId: string, turnId?: string) => {
    if (turnId === undefined || turnId.length === 0) return null
    let latest: Record<string, unknown> | null = null
    for (const line of deps.readLines?.() ?? []) {
      let entry: unknown
      try { entry = JSON.parse(line) } catch { throw new Error('SESSION_LOG_CORRUPT') }
      if (typeof entry !== 'object' || entry === null) throw new Error('SESSION_LOG_CORRUPT')
      const raw = entry as Record<string, unknown>
      if (raw['kind'] !== 'turn.checkpoint') continue
      if (typeof raw['payload'] !== 'object' || raw['payload'] === null) {
        throw new Error('SESSION_LOG_CORRUPT')
      }
      const payload = raw['payload'] as Record<string, unknown>
      if (typeof payload['sessionId'] !== 'string' || typeof payload['turnId'] !== 'string' ||
        (payload['status'] !== 'in-progress' && payload['status'] !== 'complete') ||
        !Number.isSafeInteger(payload['nextStepIndex']) ||
        (payload['nextStepIndex'] as number) < 0 ||
        !Number.isSafeInteger(payload['toolOrdinalHighWater']) ||
        (payload['toolOrdinalHighWater'] as number) < 0) {
        throw new Error('SESSION_LOG_CORRUPT')
      }
      if (payload['sessionId'] === sessionId && payload['turnId'] === turnId) latest = payload
    }
    if (latest === null || latest['status'] === 'complete') return null
    return {
      status: 'in-progress' as const,
      nextStepIndex: latest['nextStepIndex'] as number,
      toolOrdinalHighWater: latest['toolOrdinalHighWater'] as number,
    }
  }
  return {
    append: (entry: LogEntry) => deps.appendLine(JSON.stringify(entry)),
    resume,
    recent: (n: number): SessionSummary[] => {
      // Count only `turn.start`: exact-turn checkpoints also carry sessionId and
      // must not inflate the visible number of turns.
      const lines = deps.readLines?.() ?? []
      const map = new Map<string, { turns: number; lastAt: string }>()
      for (const line of lines) {
        if (!line.trim()) continue
        let entry: unknown
        try { entry = JSON.parse(line) } catch { continue }
        if (typeof entry !== 'object' || entry === null) continue
        const e = entry as Record<string, unknown>
        if (e['kind'] !== 'turn.start') continue
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

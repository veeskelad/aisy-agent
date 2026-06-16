// packages/core-ts/src/runtime/session-log.ts
// Durable append-only session log: each LogEntry is one JSON line via the
// injected sink (the node bin appends to ~/.aisy/session-log.jsonl). resume()
// returns null — full crash-resume (TurnState replay) is a deferred follow-up;
// this gives a durable, inspectable audit trail today.

import type { SessionLog, LogEntry } from '../agent-loop/types.js'

export function makeJsonlSessionLog(deps: { appendLine: (line: string) => void }): SessionLog {
  return {
    append: (entry: LogEntry) => deps.appendLine(JSON.stringify(entry)),
    resume: () => null,
  }
}

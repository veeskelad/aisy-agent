// Durable JSONL journal sink (app, Tier-4 observability wiring).
//
// Replaces the memory store's emitEvent no-op and feeds nightly + triggers.
// One JSON line per event; payloads carry ids/counts/event-names only (never
// secrets). Append is best-effort: a write failure is dropped, never thrown
// into the caller (observability must not break a commit or a turn).

export interface JournalSink {
  append(source: string, kind: string, payload: unknown): void
}

export function makeJsonlJournal(deps: { appendLine: (line: string) => void; nowIso: () => string }): JournalSink {
  return {
    append(source, kind, payload) {
      try {
        deps.appendLine(JSON.stringify({ ts: deps.nowIso(), source, kind, payload }))
      } catch {
        // best-effort: never break the caller on a journal write failure
      }
    },
  }
}

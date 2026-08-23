// Daily journal: the course of a day, next to but not inside memory (ADR-0079).
//
// Facts live in the protected ledger; what happened today lives here. The file
// changes during the day, so it never enters the frozen prefix — it is pulled
// as late context for the current turn only.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Today plus three days back. Anything older belongs in memory, not here. */
export const JOURNAL_WINDOW_DAYS = 4
/** Upper bound of what one day contributes to a turn. */
export const JOURNAL_MAX_BYTES = 4 * 1024

const DATE = /^\d{4}-\d{2}-\d{2}$/

export interface DailyJournal {
  /** Today's entries, capped, or null when nothing was written yet. */
  today(): string | null
  /** One day within the window; null when absent, refusal string when out of it. */
  read(date: string): string | null | 'out-of-window' | 'bad-date'
  /** Append one line. Written by the runtime, never by the model. */
  append(text: string): void
}

function datePart(iso: string): string {
  return iso.slice(0, 10)
}

/** Days between two calendar dates, ignoring time of day. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY
  return Math.round((b - a) / 86_400_000)
}

function readCapped(path: string): string | null {
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  if (text === '') return null
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= JOURNAL_MAX_BYTES) return text
  // Keep the end: the most recent entries are what "where did I stop" needs.
  const tail = bytes.subarray(bytes.byteLength - JOURNAL_MAX_BYTES).toString('utf8')
  const fromLineStart = tail.indexOf('\n')
  return `…\n${fromLineStart === -1 ? tail : tail.slice(fromLineStart + 1)}`
}

export function makeDailyJournal(deps: {
  /** Directory of the daily files, normally the bot's memory root. */
  root: string
  nowIso: () => string
}): DailyJournal {
  const pathFor = (date: string): string => join(deps.root, `${date}.md`)

  return {
    today() {
      return readCapped(pathFor(datePart(deps.nowIso())))
    },

    read(date) {
      // The date is data: it names a day, it does not choose a path.
      if (!DATE.test(date)) return 'bad-date'
      const today = datePart(deps.nowIso())
      const age = daysBetween(date, today)
      if (age < 0 || age >= JOURNAL_WINDOW_DAYS) return 'out-of-window'
      return readCapped(pathFor(date))
    },

    append(text) {
      const trimmed = text.replace(/\s+/g, ' ').trim()
      if (trimmed === '') return
      const iso = deps.nowIso()
      const line = `- ${iso.slice(11, 16)} ${trimmed}\n`
      try {
        if (!existsSync(deps.root)) mkdirSync(deps.root, { recursive: true, mode: 0o700 })
        const path = pathFor(datePart(iso))
        // A day starts with its own heading, so the file reads on its own.
        const header = existsSync(path) && statSync(path).size > 0
          ? ''
          : `# ${datePart(iso)}\n\n`
        appendFileSync(path, header + line, { encoding: 'utf8', mode: 0o600 })
      } catch {
        // A journal that cannot be written must not cost the operator a turn.
      }
    },
  }
}

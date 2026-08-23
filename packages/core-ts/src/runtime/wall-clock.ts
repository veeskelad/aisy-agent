// Wall-clock rendering for the operator's timezone.
//
// Everything durable in Aisy is UTC and stays UTC — timestamps, receipts,
// leases. But "каждое утро в 9" is not an instant, it is a wall-clock reading,
// and comparing it against a UTC string fires the schedule at 9 o'clock
// somewhere else. This renders the same instant as the operator would read it,
// and nothing else.

/** IANA name, e.g. `Europe/Moscow`. */
export type TimeZoneName = string

const CACHE = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: TimeZoneName): Intl.DateTimeFormat | null {
  const cached = CACHE.get(timeZone)
  if (cached !== undefined) return cached
  try {
    const created = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      // h23 rather than hour12:false: the latter renders midnight as "24" on
      // some ICU builds, which would make a 00:0x schedule never match.
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    CACHE.set(timeZone, created)
    return created
  } catch {
    return null
  }
}

/** True when the runtime knows the zone; used to refuse a typo before storing it. */
export function isKnownTimeZone(timeZone: string): boolean {
  return timeZone.length > 0 && formatter(timeZone) !== null
}

/**
 * Renders a UTC ISO instant as `YYYY-MM-DDTHH:MM:SS` in `timeZone`.
 *
 * Deliberately without a `Z` or offset suffix: the result is a wall-clock
 * reading for comparison against `HH:MM`, never an instant to parse back.
 * An unknown zone or unparseable input returns the input unchanged, so a bad
 * setting degrades to UTC scheduling instead of stopping the schedule.
 */
export function wallClockIso(nowIso: string, timeZone: TimeZoneName | undefined): string {
  if (timeZone === undefined || timeZone === 'UTC') return nowIso
  const format = formatter(timeZone)
  if (format === null) return nowIso
  const instant = new Date(nowIso)
  if (Number.isNaN(instant.getTime())) return nowIso
  const parts = format.formatToParts(instant)
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  const year = value('year')
  const month = value('month')
  const day = value('day')
  const hour = value('hour')
  const minute = value('minute')
  const second = value('second')
  if ([year, month, day, hour, minute, second].some((part) => part.length === 0)) return nowIso
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

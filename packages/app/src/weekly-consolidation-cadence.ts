import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export interface WeeklyConsolidationCadence {
  due(localDate: string): boolean
  markSuccessful(localDate: string): void
  lastSuccessfulSunday(): string | null
}

interface State {
  schemaVersion: 1
  lastSuccessfulSunday: string
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u

function exactDate(value: string): Date {
  if (!DATE.test(value)) throw new Error('INVALID_LOCAL_DATE')
  const parsed = new Date(`${value}T12:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('INVALID_LOCAL_DATE')
  }
  return parsed
}

export function latestSunday(localDate: string): string {
  const parsed = exactDate(localDate)
  parsed.setUTCDate(parsed.getUTCDate() - parsed.getUTCDay())
  return parsed.toISOString().slice(0, 10)
}

function decode(raw: string): State | null {
  if (Buffer.byteLength(raw, 'utf8') > 4096) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || record['schemaVersion'] !== 1 ||
    typeof record['lastSuccessfulSunday'] !== 'string') return null
  try {
    if (latestSunday(record['lastSuccessfulSunday']) !== record['lastSuccessfulSunday']) return null
  } catch { return null }
  return { schemaVersion: 1, lastSuccessfulSunday: record['lastSuccessfulSunday'] }
}

export function makeWeeklyConsolidationCadence(input: {
  load(): string | null
  save(content: string): void
}): WeeklyConsolidationCadence {
  let state = (() => {
    const raw = input.load()
    return raw === null ? null : decode(raw)
  })()
  return Object.freeze<WeeklyConsolidationCadence>({
    due(localDate) {
      const sunday = latestSunday(localDate)
      return state === null || state.lastSuccessfulSunday < sunday
    },
    markSuccessful(localDate) {
      const sunday = latestSunday(localDate)
      if (state !== null && state.lastSuccessfulSunday > sunday) {
        throw new Error('WEEKLY_CURSOR_REGRESSION')
      }
      const next: State = { schemaVersion: 1, lastSuccessfulSunday: sunday }
      input.save(JSON.stringify(next, null, 2) + '\n')
      state = next
    },
    lastSuccessfulSunday: () => state?.lastSuccessfulSunday ?? null,
  })
}

function sync(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function makeNodeWeeklyConsolidationCadence(path: string): WeeklyConsolidationCadence {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return makeWeeklyConsolidationCadence({
    load: () => {
      try { return existsSync(path) ? readFileSync(path, 'utf8') : null } catch { return null }
    },
    save: (content) => {
      const temporary = `${path}.tmp`
      writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
      sync(temporary)
      renameSync(temporary, path)
      sync(directory)
    },
  })
}

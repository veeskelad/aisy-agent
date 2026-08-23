import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export type SkillTelemetryOutcome = 'passed' | 'failed'

export interface SkillTelemetryRow {
  name: string
  hitCount: number
  lastUsedAt: string | null
  runCount: number
  failureCount: number
  failureRate: number
  lastOutcome: SkillTelemetryOutcome | null
}

export interface SkillTelemetryStore {
  recordLoad(name: string, usedAt: string): void
  recordOutcome(name: string, outcome: SkillTelemetryOutcome, observedAt: string): void
  snapshot(): ReadonlyArray<Readonly<SkillTelemetryRow>>
  health(): 'ready' | 'quarantined'
}

export class SkillTelemetryStoreError extends Error {
  constructor(public readonly code:
    | 'CORRUPT_SKILL_TELEMETRY'
    | 'INVALID_SKILL_TELEMETRY'
    | 'UNSAFE_SKILL_TELEMETRY_STORE',
  ) {
    super(code)
    this.name = 'SkillTelemetryStoreError'
  }
}

export interface JsonSkillTelemetryStoreDeps {
  exists(): boolean
  read(): string
  saveAtomic(content: string): void
}

interface TelemetryFileV1 {
  schemaVersion: 1
  rows: SkillTelemetryRow[]
}

const NAME = /^[a-z0-9][a-z0-9-]*$/
const MAX_ROWS = 10_000
const MAX_BYTES = 4 * 1024 * 1024

function exactIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function validateRow(value: unknown): SkillTelemetryRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillTelemetryStoreError('INVALID_SKILL_TELEMETRY')
  }
  const row = value as Record<string, unknown>
  if (typeof row['name'] !== 'string' || !NAME.test(row['name']) ||
    !Number.isSafeInteger(row['hitCount']) || Number(row['hitCount']) < 0 ||
    (row['lastUsedAt'] !== null && !exactIso(row['lastUsedAt'])) ||
    !Number.isSafeInteger(row['runCount']) || Number(row['runCount']) < 0 ||
    !Number.isSafeInteger(row['failureCount']) || Number(row['failureCount']) < 0 ||
    Number(row['failureCount']) > Number(row['runCount']) ||
    typeof row['failureRate'] !== 'number' || !Number.isFinite(row['failureRate']) ||
    row['failureRate'] < 0 || row['failureRate'] > 1 ||
    (row['lastOutcome'] !== null && row['lastOutcome'] !== 'passed' && row['lastOutcome'] !== 'failed')) {
    throw new SkillTelemetryStoreError('INVALID_SKILL_TELEMETRY')
  }
  const expectedRate = Number(row['runCount']) === 0 ? 0 : Number(row['failureCount']) / Number(row['runCount'])
  if (row['failureRate'] !== expectedRate) throw new SkillTelemetryStoreError('INVALID_SKILL_TELEMETRY')
  return {
    name: row['name'], hitCount: Number(row['hitCount']), lastUsedAt: row['lastUsedAt'] as string | null,
    runCount: Number(row['runCount']), failureCount: Number(row['failureCount']),
    failureRate: row['failureRate'], lastOutcome: row['lastOutcome'] as SkillTelemetryOutcome | null,
  }
}

function validateFile(value: unknown): TelemetryFileV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillTelemetryStoreError('CORRUPT_SKILL_TELEMETRY')
  }
  const file = value as Record<string, unknown>
  if (file['schemaVersion'] !== 1 || !Array.isArray(file['rows']) || file['rows'].length > MAX_ROWS) {
    throw new SkillTelemetryStoreError('CORRUPT_SKILL_TELEMETRY')
  }
  try {
    const rows = file['rows'].map(validateRow)
    if (new Set(rows.map(row => row.name)).size !== rows.length) throw new Error('duplicate')
    return { schemaVersion: 1, rows }
  } catch {
    throw new SkillTelemetryStoreError('CORRUPT_SKILL_TELEMETRY')
  }
}

export function makeJsonSkillTelemetryStore(deps: JsonSkillTelemetryStoreDeps): SkillTelemetryStore {
  let rows: SkillTelemetryRow[] = []
  if (deps.exists()) {
    try {
      const raw = deps.read()
      if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('oversized')
      rows = validateFile(JSON.parse(raw) as unknown).rows
    } catch {
      throw new SkillTelemetryStoreError('CORRUPT_SKILL_TELEMETRY')
    }
  }
  const publish = (next: SkillTelemetryRow[]): void => {
    const file = validateFile({ schemaVersion: 1, rows: next.sort((a, b) => a.name.localeCompare(b.name)) })
    const content = JSON.stringify(file, null, 2) + '\n'
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new SkillTelemetryStoreError('INVALID_SKILL_TELEMETRY')
    deps.saveAtomic(content)
    rows = file.rows
  }
  const update = (name: string, mutate: (row: SkillTelemetryRow) => SkillTelemetryRow): void => {
    if (!NAME.test(name)) throw new SkillTelemetryStoreError('INVALID_SKILL_TELEMETRY')
    const current = rows.find(row => row.name === name) ?? {
      name, hitCount: 0, lastUsedAt: null, runCount: 0, failureCount: 0, failureRate: 0, lastOutcome: null,
    }
    publish([...rows.filter(row => row.name !== name), mutate({ ...current })])
  }
  return Object.freeze<SkillTelemetryStore>({
    recordLoad(name, usedAt) {
      if (!exactIso(usedAt)) throw new SkillTelemetryStoreError('INVALID_SKILL_TELEMETRY')
      update(name, row => ({ ...row, hitCount: row.hitCount + 1, lastUsedAt: usedAt }))
    },
    recordOutcome(name, outcome, observedAt) {
      if (!exactIso(observedAt) || (outcome !== 'passed' && outcome !== 'failed')) {
        throw new SkillTelemetryStoreError('INVALID_SKILL_TELEMETRY')
      }
      update(name, row => {
        const runCount = row.runCount + 1
        const failureCount = row.failureCount + (outcome === 'failed' ? 1 : 0)
        return {
          ...row, lastUsedAt: observedAt, runCount, failureCount,
          failureRate: failureCount / runCount, lastOutcome: outcome,
        }
      })
    },
    snapshot: () => Object.freeze(rows.map(row => Object.freeze({ ...row }))),
    health: () => 'ready',
  })
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function assertPrivateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES ||
    realpathSync(path) !== path || (stat.mode & 0o077) !== 0) {
    throw new SkillTelemetryStoreError('UNSAFE_SKILL_TELEMETRY_STORE')
  }
}

function quarantinedStore(): SkillTelemetryStore {
  return Object.freeze({
    recordLoad: () => {}, recordOutcome: () => {}, snapshot: () => Object.freeze([]), health: () => 'quarantined',
  })
}

export function makeNodeSkillTelemetryStore(input: { path: string }): SkillTelemetryStore {
  const requested = resolve(input.path)
  const requestedDirectory = dirname(requested)
  mkdirSync(requestedDirectory, { recursive: true, mode: 0o700 })
  const directory = realpathSync(requestedDirectory)
  chmodSync(directory, 0o700)
  const path = join(directory, basename(requested))
  if (existsSync(path)) assertPrivateFile(path)
  const saveAtomic = (target: string, content: string): void => {
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    syncPath(temporary)
    renameSync(temporary, target)
    syncPath(directory)
  }
  try {
    return makeJsonSkillTelemetryStore({
      exists: () => existsSync(path), read: () => readFileSync(path, 'utf8'),
      saveAtomic: content => saveAtomic(path, content),
    })
  } catch (error) {
    if (!(error instanceof SkillTelemetryStoreError) || error.code !== 'CORRUPT_SKILL_TELEMETRY') throw error
    // Preserve the corrupt source bytes and publish only a redacted quarantine marker.
    saveAtomic(path + '.quarantine', JSON.stringify({ schemaVersion: 1, reason: 'corrupt' }) + '\n')
    return quarantinedStore()
  }
}

export type SkillTelemetryInspection = Readonly<{
  status: 'absent' | 'ready' | 'corrupt' | 'unsafe'
  rows: number
}>

export function inspectNodeSkillTelemetryStore(pathInput: string): SkillTelemetryInspection {
  const requested = resolve(pathInput)
  const directory = dirname(requested)
  const path = existsSync(directory) ? join(realpathSync(directory), basename(requested)) : requested
  if (!existsSync(path)) return Object.freeze({ status: 'absent', rows: 0 })
  try {
    assertPrivateFile(path)
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('oversized')
    return Object.freeze({ status: 'ready' as const, rows: validateFile(JSON.parse(raw) as unknown).rows.length })
  } catch (error) {
    const status = error instanceof SkillTelemetryStoreError && error.code === 'UNSAFE_SKILL_TELEMETRY_STORE'
      ? 'unsafe' as const : 'corrupt' as const
    return Object.freeze({ status, rows: 0 })
  }
}

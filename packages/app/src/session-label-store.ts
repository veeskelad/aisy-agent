import { randomUUID } from 'node:crypto'
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

export type SessionLabelKind = 'temporary' | 'explicit'

export interface SessionLabelRecordV1 {
  sessionId: string
  kind: SessionLabelKind
  revision: number
  updatedAt: string
}

export interface SessionLabelStateV1 {
  schemaVersion: 1
  labels: SessionLabelRecordV1[]
}

export interface SessionLabelStore {
  /** Missing metadata is a legacy explicit name; callers must never auto-rename it. */
  get(sessionId: string): SessionLabelRecordV1 | null
  markTemporary(sessionId: string): SessionLabelRecordV1
  markExplicit(sessionId: string, expectedRevision?: number): SessionLabelRecordV1
  remove(sessionId: string): void
  snapshot(): SessionLabelStateV1
}

export class SessionLabelStoreError extends Error {
  constructor(public readonly code:
    | 'CORRUPT_SESSION_LABEL_STORE'
    | 'INVALID_SESSION_ID'
    | 'SESSION_LABEL_EXPLICIT'
    | 'STALE_SESSION_LABEL_REVISION') {
    super(code)
    this.name = 'SessionLabelStoreError'
  }
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const MAX_BYTES = 1024 * 1024

function clone(state: SessionLabelStateV1): SessionLabelStateV1 {
  return { schemaVersion: 1, labels: state.labels.map((label) => ({ ...label })) }
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && ISO.test(value) && new Date(value).toISOString() === value
}

function validate(value: unknown): SessionLabelStateV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionLabelStoreError('CORRUPT_SESSION_LABEL_STORE')
  }
  const candidate = value as Partial<SessionLabelStateV1>
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.labels) ||
    Object.keys(candidate).some((key) => !['schemaVersion', 'labels'].includes(key))) {
    throw new SessionLabelStoreError('CORRUPT_SESSION_LABEL_STORE')
  }
  const ids = new Set<string>()
  for (const label of candidate.labels) {
    if (typeof label !== 'object' || label === null || Array.isArray(label)) {
      throw new SessionLabelStoreError('CORRUPT_SESSION_LABEL_STORE')
    }
    const record = label as Partial<SessionLabelRecordV1>
    if (typeof record.sessionId !== 'string' || !SESSION_ID.test(record.sessionId) ||
      ids.has(record.sessionId) || (record.kind !== 'temporary' && record.kind !== 'explicit') ||
      !Number.isSafeInteger(record.revision) || (record.revision ?? 0) < 1 ||
      !validIso(record.updatedAt) ||
      Object.keys(record).some((key) => !['sessionId', 'kind', 'revision', 'updatedAt'].includes(key))) {
      throw new SessionLabelStoreError('CORRUPT_SESSION_LABEL_STORE')
    }
    ids.add(record.sessionId)
  }
  return clone(candidate as SessionLabelStateV1)
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new SessionLabelStoreError('INVALID_SESSION_ID')
}

function makeStore(input: {
  initial?: SessionLabelStateV1
  nowIso: () => string
  save: (state: SessionLabelStateV1) => void
}): SessionLabelStore {
  let state = validate(input.initial ?? { schemaVersion: 1, labels: [] })
  const publish = (candidate: SessionLabelStateV1): void => {
    const next = validate(candidate)
    input.save(next)
    state = next
  }
  const get = (sessionId: string): SessionLabelRecordV1 | null => {
    assertSessionId(sessionId)
    const found = state.labels.find((label) => label.sessionId === sessionId)
    return found === undefined ? null : { ...found }
  }
  return Object.freeze<SessionLabelStore>({
    get,
    markTemporary(sessionId) {
      const current = get(sessionId)
      if (current?.kind === 'explicit') throw new SessionLabelStoreError('SESSION_LABEL_EXPLICIT')
      if (current !== null) return current
      const created: SessionLabelRecordV1 = {
        sessionId,
        kind: 'temporary',
        revision: 1,
        updatedAt: input.nowIso(),
      }
      publish({ ...state, labels: [...state.labels, created] })
      return { ...created }
    },
    markExplicit(sessionId, expectedRevision) {
      const current = get(sessionId)
      if (expectedRevision !== undefined && current?.revision !== expectedRevision) {
        throw new SessionLabelStoreError('STALE_SESSION_LABEL_REVISION')
      }
      const next: SessionLabelRecordV1 = {
        sessionId,
        kind: 'explicit',
        revision: (current?.revision ?? 0) + 1,
        updatedAt: input.nowIso(),
      }
      publish({
        ...state,
        labels: [...state.labels.filter((label) => label.sessionId !== sessionId), next],
      })
      return { ...next }
    },
    remove(sessionId) {
      const current = get(sessionId)
      if (current === null) return
      publish({ ...state, labels: state.labels.filter((label) => label.sessionId !== sessionId) })
    },
    snapshot: () => clone(state),
  })
}

export function makeMemorySessionLabelStore(input: {
  initial?: SessionLabelStateV1
  nowIso?: () => string
  save?: (state: SessionLabelStateV1) => void
} = {}): SessionLabelStore {
  return makeStore({
    ...(input.initial === undefined ? {} : { initial: input.initial }),
    nowIso: input.nowIso ?? (() => '2026-08-29T00:00:00.000Z'),
    save: input.save ?? (() => undefined),
  })
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function makeNodeSessionLabelStore(input: {
  path: string
  nowIso?: () => string
}): SessionLabelStore {
  const directory = dirname(input.path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let initial: SessionLabelStateV1 = { schemaVersion: 1, labels: [] }
  if (existsSync(input.path)) {
    const raw = readFileSync(input.path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
      throw new SessionLabelStoreError('CORRUPT_SESSION_LABEL_STORE')
    }
    try {
      initial = validate(JSON.parse(raw) as unknown)
    } catch (error) {
      if (error instanceof SessionLabelStoreError) throw error
      throw new SessionLabelStoreError('CORRUPT_SESSION_LABEL_STORE')
    }
  }
  return makeStore({
    initial,
    nowIso: input.nowIso ?? (() => new Date().toISOString()),
    save: (state) => {
      const temporary = `${input.path}.tmp-${process.pid}-${randomUUID()}`
      writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      })
      syncPath(temporary)
      renameSync(temporary, input.path)
      syncPath(directory)
    },
  })
}

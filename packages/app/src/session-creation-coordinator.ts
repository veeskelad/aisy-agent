import { createHash, randomUUID } from 'node:crypto'
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
import type {
  ProjectRegistryV2,
  ProjectRegistryV2Owner,
  ProjectService,
  ProjectSessionRecord,
} from '@aisy/core'

import type { SessionLabelKind, SessionLabelStore } from './session-label-store.js'

export type SessionCreationPhase = 'prepared' | 'registry-created' | 'terminal' | 'cancelled'

export interface SessionCreationRecordV1 extends ProjectRegistryV2Owner {
  schemaVersion: 1
  projectId: string
  sessionId: string
  expectedGeneration: number
  createKeyHash: string
  name: string
  labelKind: SessionLabelKind
  phase: SessionCreationPhase
}

export interface SessionCreationStateV1 {
  schemaVersion: 1
  records: SessionCreationRecordV1[]
}

export interface SessionCreationStore {
  load(): SessionCreationStateV1
  save(state: SessionCreationStateV1): void
}

export interface SessionCreationCoordinator {
  create(input: ProjectRegistryV2Owner & {
    projectId: string
    expectedGeneration: number
    requestKey: string
    name?: string
  }): ProjectSessionRecord
  prepareExternal(input: Omit<SessionCreationRecordV1, 'schemaVersion' | 'phase'>): SessionCreationRecordV1
  completeExternal(createKeyHash: string): ProjectSessionRecord
  repair(): { repaired: number; cancelled: number }
  snapshot(): SessionCreationStateV1
}

const HASH = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u
const PHASES = new Set<SessionCreationPhase>([
  'prepared', 'registry-created', 'terminal', 'cancelled',
])
const MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_NAME = 'Новая сессия'

function clone(state: SessionCreationStateV1): SessionCreationStateV1 {
  return { schemaVersion: 1, records: state.records.map((record) => ({ ...record })) }
}

function validate(value: unknown): SessionCreationStateV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SESSION_CREATION_STATE_CORRUPT')
  }
  const state = value as Partial<SessionCreationStateV1>
  if (state.schemaVersion !== 1 || !Array.isArray(state.records) ||
    Object.keys(state).some((key) => !['schemaVersion', 'records'].includes(key))) {
    throw new Error('SESSION_CREATION_STATE_CORRUPT')
  }
  const keys = new Set<string>()
  for (const raw of state.records) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('SESSION_CREATION_STATE_CORRUPT')
    }
    const record = raw as Partial<SessionCreationRecordV1>
    if (record.schemaVersion !== 1 || typeof record.operatorId !== 'string' ||
      typeof record.profileId !== 'string' || typeof record.projectId !== 'string' ||
      typeof record.sessionId !== 'string' || !ID.test(record.sessionId) ||
      !Number.isSafeInteger(record.expectedGeneration) || (record.expectedGeneration ?? 0) < 1 ||
      typeof record.createKeyHash !== 'string' || !HASH.test(record.createKeyHash) ||
      typeof record.name !== 'string' || record.name.length < 1 || record.name.length > 128 ||
      (record.labelKind !== 'temporary' && record.labelKind !== 'explicit') ||
      !PHASES.has(record.phase as SessionCreationPhase) || keys.has(record.createKeyHash) ||
      Object.keys(record).some((key) => ![
        'schemaVersion', 'operatorId', 'profileId', 'projectId', 'sessionId',
        'expectedGeneration', 'createKeyHash', 'name', 'labelKind', 'phase',
      ].includes(key))) {
      throw new Error('SESSION_CREATION_STATE_CORRUPT')
    }
    keys.add(record.createKeyHash)
  }
  return clone(state as SessionCreationStateV1)
}

export function normalizeSessionName(value: string): string {
  const normalized = value.normalize('NFKC')
  if (/[\p{Cc}\p{Cf}<>`]/u.test(normalized)) {
    throw new Error('SESSION_NAME_INVALID')
  }
  const name = normalized.trim().replace(/\s+/gu, ' ')
  if (name.length === 0 || Array.from(name).length > 64) {
    throw new Error('SESSION_NAME_INVALID')
  }
  return name
}

function cleanName(value: string | undefined): { name: string; labelKind: SessionLabelKind } {
  if (value === undefined || value.trim().length === 0) {
    return { name: DEFAULT_NAME, labelKind: 'temporary' }
  }
  return { name: normalizeSessionName(value), labelKind: 'explicit' }
}

function identity(input: ProjectRegistryV2Owner & {
  projectId: string
  requestKey: string
}): { createKeyHash: string; sessionId: string } {
  if (input.requestKey.length < 1 || input.requestKey.length > 512) {
    throw new Error('SESSION_CREATION_REQUEST_KEY_INVALID')
  }
  const createKeyHash = createHash('sha256')
    .update('aisy-session-creation/v1')
    .update('\0').update(input.operatorId)
    .update('\0').update(input.profileId)
    .update('\0').update(input.projectId)
    .update('\0').update(input.requestKey)
    .digest('hex')
  return { createKeyHash, sessionId: `session-${createKeyHash.slice(0, 32)}` }
}

export function makeSessionCreationCoordinator(input: {
  registry: ProjectRegistryV2
  service: ProjectService
  labels: SessionLabelStore
  store: SessionCreationStore
}): SessionCreationCoordinator {
  let state = validate(input.store.load())
  const publish = (candidate: SessionCreationStateV1): void => {
    const next = validate(candidate)
    input.store.save(next)
    state = next
  }
  const replace = (record: SessionCreationRecordV1): void => publish({
    ...state,
    records: [...state.records.filter((item) => item.createKeyHash !== record.createKeyHash), record],
  })
  const prepareExternal = (
    raw: Omit<SessionCreationRecordV1, 'schemaVersion' | 'phase'>,
  ): SessionCreationRecordV1 => {
    const existing = state.records.find((item) => item.createKeyHash === raw.createKeyHash)
    if (existing !== undefined) {
      if (existing.operatorId !== raw.operatorId || existing.profileId !== raw.profileId ||
        existing.projectId !== raw.projectId || existing.sessionId !== raw.sessionId ||
        existing.createKeyHash !== raw.createKeyHash || existing.name !== raw.name ||
        existing.labelKind !== raw.labelKind) {
        throw new Error('SESSION_CREATION_IDENTITY_CONFLICT')
      }
      return { ...existing }
    }
    const prepared = validate({
      schemaVersion: 1,
      records: [{ schemaVersion: 1, ...raw, phase: 'prepared' }],
    }).records[0]!
    replace(prepared)
    return { ...prepared }
  }
  const complete = (record: SessionCreationRecordV1): ProjectSessionRecord => {
    const session = input.registry.getSession({
      operatorId: record.operatorId,
      profileId: record.profileId,
      projectId: record.projectId,
      sessionId: record.sessionId,
    })
    if (session.createKeyHash !== record.createKeyHash || session.name !== record.name) {
      throw new Error('SESSION_CREATION_REGISTRY_MISMATCH')
    }
    if (record.phase === 'prepared') replace({ ...record, phase: 'registry-created' })
    const label = input.labels.get(record.sessionId)
    if (record.labelKind === 'temporary') {
      if (label === null) input.labels.markTemporary(record.sessionId)
      else if (label.kind !== 'temporary') throw new Error('SESSION_CREATION_LABEL_MISMATCH')
    } else if (label === null) input.labels.markExplicit(record.sessionId)
    else if (label.kind !== 'explicit') input.labels.markExplicit(record.sessionId, label.revision)
    const latest = state.records.find((item) => item.createKeyHash === record.createKeyHash) ?? record
    if (latest.phase !== 'terminal') replace({ ...latest, phase: 'terminal' })
    return session
  }
  return Object.freeze<SessionCreationCoordinator>({
    create(raw) {
      const derived = identity(raw)
      const label = cleanName(raw.name)
      const record = prepareExternal({
        operatorId: raw.operatorId,
        profileId: raw.profileId,
        projectId: raw.projectId,
        sessionId: derived.sessionId,
        expectedGeneration: raw.expectedGeneration,
        createKeyHash: derived.createKeyHash,
        name: label.name,
        labelKind: label.labelKind,
      })
      if (record.phase === 'terminal') return complete(record)
      input.service.createSession({
        operatorId: record.operatorId,
        profileId: record.profileId,
        projectId: record.projectId,
        sessionId: record.sessionId,
        createKeyHash: record.createKeyHash,
        expectedGeneration: record.expectedGeneration,
        name: record.name,
      })
      return complete(record)
    },
    prepareExternal,
    completeExternal(createKeyHash) {
      const record = state.records.find((item) => item.createKeyHash === createKeyHash)
      if (record === undefined) throw new Error('SESSION_CREATION_RECORD_NOT_FOUND')
      return complete(record)
    },
    repair() {
      let repaired = 0
      let cancelled = 0
      for (const record of [...state.records]) {
        if (record.phase === 'terminal' || record.phase === 'cancelled') continue
        try {
          complete(record)
          repaired += 1
        } catch (error) {
          const code = (error as { code?: unknown }).code
          if (code !== 'SESSION_NOT_FOUND') throw error
          const latest = state.records.find((item) => item.createKeyHash === record.createKeyHash) ?? record
          replace({ ...latest, phase: 'cancelled' })
          cancelled += 1
        }
      }
      return { repaired, cancelled }
    },
    snapshot: () => clone(state),
  })
}

export function makeMemorySessionCreationStore(input: {
  initial?: SessionCreationStateV1
  save?: (state: SessionCreationStateV1) => void
} = {}): SessionCreationStore {
  let state = validate(input.initial ?? { schemaVersion: 1, records: [] })
  return {
    load: () => clone(state),
    save: (candidate) => {
      const next = validate(candidate)
      input.save?.(next)
      state = next
    },
  }
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function makeNodeSessionCreationStore(path: string): SessionCreationStore {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let state: SessionCreationStateV1 = { schemaVersion: 1, records: [] }
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('SESSION_CREATION_STATE_CORRUPT')
    try { state = validate(JSON.parse(raw) as unknown) } catch { throw new Error('SESSION_CREATION_STATE_CORRUPT') }
  }
  return makeMemorySessionCreationStore({
    initial: state,
    save: (candidate) => {
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
      writeFileSync(temporary, JSON.stringify(candidate, null, 2) + '\n', {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      })
      syncPath(temporary)
      renameSync(temporary, path)
      syncPath(directory)
    },
  })
}

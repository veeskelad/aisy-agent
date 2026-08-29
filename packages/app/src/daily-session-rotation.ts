import { createHash } from 'node:crypto'
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

import type { ProjectService, ProjectRegistryV2, SessionRotationAuthority } from '@aisy/core'

import type { TelegramNightlyNotice } from './bot.js'
import type { SessionCreationCoordinator } from './session-creation-coordinator.js'

export type DailySessionRotationPhase =
  | 'preparing'
  | 'switched'
  | 'restart_requested'
  | 'dispatching'
  | 'delivered'
  | 'ambiguous'
  | 'cancelled-stale'

export interface DailySessionRotationRecord {
  schemaVersion: 1
  botId: string
  operatorId: string
  profileId: string
  localDate: string
  projectId: string
  sourceSessionId: string
  newSessionId: string
  expectedGeneration: number
  createKeyHash: string
  notice: TelegramNightlyNotice
  phase: DailySessionRotationPhase
}

export interface DailySessionRotationStore {
  load(): DailySessionRotationRecord | null
  save(record: DailySessionRotationRecord): void
}

export type DailySessionNotice =
  | { kind: 'session-only' }
  | { kind: 'complete-zero' }
  | { kind: 'complete-n'; pending: number }
  | { kind: 'partial-failure'; pending: number; failedProjects: number }

export interface DailySessionRotation {
  rotate(localDate: string, notice: DailySessionNotice): Promise<void>
  markRestartRequested(localDate: string): void
  recoverNotification(
    send: (notice: TelegramNightlyNotice) => Promise<void>,
  ): Promise<'none' | 'delivered' | 'ambiguous'>
  current(): DailySessionRotationRecord | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u
const HASH = /^[a-f0-9]{64}$/u
const PHASES = new Set<DailySessionRotationPhase>([
  'preparing', 'switched', 'restart_requested', 'dispatching',
  'delivered', 'ambiguous', 'cancelled-stale',
])

function clone(record: DailySessionRotationRecord): DailySessionRotationRecord {
  return structuredClone(record)
}

function validNotice(value: unknown): value is TelegramNightlyNotice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const notice = value as Partial<TelegramNightlyNotice>
  if (notice.sessionReset !== true) return false
  if (notice.kind === 'session-only' || notice.kind === 'complete-zero') return true
  if (notice.kind === 'complete-n') {
    return Number.isSafeInteger(notice.pending) && (notice.pending ?? 0) > 0
  }
  return notice.kind === 'partial-failure' &&
    Number.isSafeInteger(notice.pending) && (notice.pending ?? -1) >= 0 &&
    Number.isSafeInteger(notice.failedProjects) && (notice.failedProjects ?? 0) > 0
}

function decode(raw: string): DailySessionRotationRecord | null {
  if (Buffer.byteLength(raw, 'utf8') > 16_384) return null
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Partial<DailySessionRotationRecord>
  if (record.schemaVersion !== 1 || typeof record.botId !== 'string' ||
    typeof record.operatorId !== 'string' || typeof record.profileId !== 'string' ||
    typeof record.localDate !== 'string' || !DATE.test(record.localDate) ||
    typeof record.projectId !== 'string' || typeof record.sourceSessionId !== 'string' ||
    typeof record.newSessionId !== 'string' || !Number.isSafeInteger(record.expectedGeneration) ||
    (record.expectedGeneration ?? 0) < 1 || typeof record.createKeyHash !== 'string' ||
    !HASH.test(record.createKeyHash) || !PHASES.has(record.phase as DailySessionRotationPhase) ||
    !validNotice(record.notice)) return null
  return clone(record as DailySessionRotationRecord)
}

function rotationIdentity(input: {
  botId: string
  operatorId: string
  profileId: string
  projectId: string
  sourceSessionId: string
  expectedGeneration: number
  localDate: string
}): { createKeyHash: string; newSessionId: string } {
  const createKeyHash = createHash('sha256')
    .update('aisy-daily-session-create/v1')
    .update('\0').update(input.botId)
    .update('\0').update(input.operatorId)
    .update('\0').update(input.profileId)
    .update('\0').update(input.projectId)
    .update('\0').update(input.sourceSessionId)
    .update('\0').update(String(input.expectedGeneration))
    .update('\0').update(input.localDate)
    .digest('hex')
  return { createKeyHash, newSessionId: `daily-${createKeyHash.slice(0, 32)}` }
}

export function makeDailySessionRotation(input: {
  botId: string
  operatorId: string
  profileId: string
  registry: ProjectRegistryV2
  service: ProjectService
  authority: SessionRotationAuthority
  store: DailySessionRotationStore
  creation: Pick<SessionCreationCoordinator, 'prepareExternal' | 'completeExternal'>
}): DailySessionRotation {
  const owner = { operatorId: input.operatorId, profileId: input.profileId }
  let state = input.store.load()
  const publish = (next: DailySessionRotationRecord): void => {
    input.store.save(next)
    state = clone(next)
  }

  const continueRotation = async (record: DailySessionRotationRecord): Promise<void> => {
    const current = input.registry.getActive(owner)
    if (current.projectId === record.projectId && current.sessionId === record.newSessionId &&
      current.generation === record.expectedGeneration + 1) {
      input.creation.completeExternal(record.createKeyHash)
      publish({ ...record, phase: 'switched' })
      return
    }
    if (current.projectId !== record.projectId || current.sessionId !== record.sourceSessionId ||
      current.generation !== record.expectedGeneration) {
      publish({ ...record, phase: 'cancelled-stale' })
      throw new Error('DAILY_SESSION_ROTATION_STALE')
    }
    const binding = {
      ...owner,
      projectId: record.projectId,
      sourceSessionId: record.sourceSessionId,
      newSessionId: record.newSessionId,
      expectedGeneration: record.expectedGeneration,
      localDate: record.localDate,
      createKeyHash: record.createKeyHash,
    }
    input.creation.prepareExternal({
      ...owner,
      projectId: record.projectId,
      sessionId: record.newSessionId,
      expectedGeneration: record.expectedGeneration,
      createKeyHash: record.createKeyHash,
      name: record.localDate,
      labelKind: 'temporary',
    })
    const receipt = input.authority.issue(binding, 60_000)
    await input.service.rotateSession({
      ...binding,
      receipt,
      name: record.localDate,
    })
    input.creation.completeExternal(record.createKeyHash)
    publish({ ...record, phase: 'switched' })
  }

  return Object.freeze<DailySessionRotation>({
    async rotate(localDate, rawNotice) {
      if (!DATE.test(localDate)) throw new Error('INVALID_LOCAL_DATE')
      if (state?.localDate === localDate && state.phase !== 'cancelled-stale') {
        if (state.phase === 'preparing') await continueRotation(state)
        return
      }
      const current = input.registry.getActive(owner)
      const identity = rotationIdentity({
        botId: input.botId,
        ...owner,
        projectId: current.projectId,
        sourceSessionId: current.sessionId,
        expectedGeneration: current.generation,
        localDate,
      })
      const notice = { ...rawNotice, sessionReset: true } as TelegramNightlyNotice
      if (!validNotice(notice)) throw new Error('INVALID_NIGHTLY_NOTICE')
      const preparing: DailySessionRotationRecord = {
        schemaVersion: 1,
        botId: input.botId,
        ...owner,
        localDate,
        projectId: current.projectId,
        sourceSessionId: current.sessionId,
        newSessionId: identity.newSessionId,
        expectedGeneration: current.generation,
        createKeyHash: identity.createKeyHash,
        notice,
        phase: 'preparing',
      }
      publish(preparing)
      await continueRotation(preparing)
    },

    markRestartRequested(localDate) {
      if (state?.localDate !== localDate || state.phase !== 'switched') {
        throw new Error('DAILY_SESSION_NOT_SWITCHED')
      }
      publish({ ...state, phase: 'restart_requested' })
    },

    async recoverNotification(send) {
      if (state === null || state.phase === 'delivered' || state.phase === 'ambiguous' ||
        state.phase === 'cancelled-stale' || state.phase === 'preparing') return 'none'
      if (state.phase === 'dispatching') {
        publish({ ...state, phase: 'ambiguous' })
        return 'ambiguous'
      }
      const dispatching = { ...state, phase: 'dispatching' as const }
      publish(dispatching)
      try {
        await send(dispatching.notice)
        publish({ ...dispatching, phase: 'delivered' })
        return 'delivered'
      } catch {
        publish({ ...dispatching, phase: 'ambiguous' })
        return 'ambiguous'
      }
    },

    current: () => state === null ? null : clone(state),
  })
}

function sync(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function makeNodeDailySessionRotationStore(path: string): DailySessionRotationStore {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return {
    load: () => {
      if (!existsSync(path)) return null
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        throw new Error('DAILY_SESSION_ROTATION_STATE_UNREADABLE')
      }
      const record = decode(raw)
      if (record === null) throw new Error('DAILY_SESSION_ROTATION_STATE_CORRUPT')
      return record
    },
    save: (record) => {
      const temporary = `${path}.tmp`
      writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', {
        encoding: 'utf8', mode: 0o600,
      })
      sync(temporary)
      renameSync(temporary, path)
      sync(directory)
    },
  }
}

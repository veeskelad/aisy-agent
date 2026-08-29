import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  ProjectRegistryV2Error,
  type ProjectRegistryV2,
  type ProjectRegistryV2Owner,
  type ProjectRegistryV2SessionFence,
  type ProjectService,
  type ProjectSelectionV2,
} from '@aisy/core'

import type { SessionCreationCoordinator } from './session-creation-coordinator.js'
import type { SessionLabelStore } from './session-label-store.js'
import type { NodeSessionTranscriptMaintenance } from './session-transcript-store.js'

export type SessionDeletionPhase =
  | 'prepared-and-fenced'
  | 'replacement-selected'
  | 'dependants-settled'
  | 'provider-purge-pending'
  | 'provider-purged'
  | 'transcript-rewrite-prepared'
  | 'transcript-rewritten'
  | 'registry-removed'
  | 'target-controls-removed'
  | 'terminal'
  | 'restart-requested'
  | 'restart-acknowledged'

export type SessionProviderPurgeHandle =
  | { kind: 'none'; adapterRevision: string }
  | {
      kind: 'resumable'
      adapterRevision: string
      resourceHash: string
      sealedHandle: string
    }

export interface SessionDeletionRecordV1 extends ProjectRegistryV2Owner {
  schemaVersion: 1
  operationHash: string
  projectId: string
  sessionId: string
  expectedGeneration?: number
  sourceUpdateId?: number
  transcriptHead?: string
  activeAtPrepare?: boolean
  providerPurge?: SessionProviderPurgeHandle
  replacement?: {
    sessionId: string
    createKeyHash: string
    name: string
  }
  selectionGeneration?: number
  deletedAt: string
  restartRequired?: boolean
  /** Telegram update whose replay must be consumed by the replacement boot. */
  restartUpdateId?: number
  purgeRevision?: number
  purgedAt?: string
  phase: SessionDeletionPhase
}

type PreparedSessionDeletionRecord = SessionDeletionRecordV1 & {
  expectedGeneration: number
  sourceUpdateId: number
  transcriptHead: string
  activeAtPrepare: boolean
  providerPurge: SessionProviderPurgeHandle
}

export interface SessionDeletionStateV1 {
  schemaVersion: 1
  records: SessionDeletionRecordV1[]
}

export interface SessionDeletionPersistence {
  load(): SessionDeletionStateV1
  save(state: SessionDeletionStateV1): void
}

export interface SessionDeletionJournal extends ProjectRegistryV2SessionFence {
  prepare(record: Omit<PreparedSessionDeletionRecord, 'schemaVersion' | 'phase'>): PreparedSessionDeletionRecord
  advance(
    operationHash: string,
    expectedPhase: SessionDeletionPhase,
    phase: SessionDeletionPhase,
    patch?: Pick<SessionDeletionRecordV1, 'selectionGeneration'>,
  ): SessionDeletionRecordV1
  complete(
    operationHash: string,
    expectedPhase: 'target-controls-removed',
    purgedAt: string,
  ): SessionDeletionRecordV1
  get(operationHash: string): SessionDeletionRecordV1 | null
  snapshot(): SessionDeletionStateV1
}

export interface SessionDeletionCoordinator {
  deleteConfirmed(input: ProjectRegistryV2Owner & {
    projectId: string
    sessionId: string
    expectedGeneration: number
    sourceUpdateId: number
    transcriptHead: string
  }): Promise<SessionDeletionRecordV1>
  repair(): Promise<{ recovered: number }>
  /** Called only by the new boot after it proves the exact prepared restart. */
  acknowledgeRestart(operationHash: string): SessionDeletionRecordV1
}

const HASH = /^[a-f0-9]{64}$/u
const DELETION_RESTART_REASON =
  /^telegram-update:(?:0|[1-9]\d*) · session deletion ([a-f0-9]{64})$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u
const PHASES = new Set<SessionDeletionPhase>([
  'prepared-and-fenced', 'replacement-selected', 'dependants-settled',
  'provider-purge-pending', 'provider-purged', 'transcript-rewrite-prepared',
  'transcript-rewritten', 'registry-removed', 'target-controls-removed',
  'terminal', 'restart-requested', 'restart-acknowledged',
])
const MAX_BYTES = 4 * 1024 * 1024
const TERMINAL_PHASES = new Set<SessionDeletionPhase>([
  'terminal', 'restart-requested', 'restart-acknowledged',
])
const TRANSITIONS = new Map<SessionDeletionPhase, SessionDeletionPhase>([
  ['prepared-and-fenced', 'replacement-selected'],
  ['replacement-selected', 'dependants-settled'],
  ['dependants-settled', 'provider-purge-pending'],
  ['provider-purge-pending', 'provider-purged'],
  ['provider-purged', 'transcript-rewrite-prepared'],
  ['transcript-rewrite-prepared', 'transcript-rewritten'],
  ['transcript-rewritten', 'registry-removed'],
  ['registry-removed', 'target-controls-removed'],
  ['terminal', 'restart-requested'],
  ['restart-requested', 'restart-acknowledged'],
])

function clone(state: SessionDeletionStateV1): SessionDeletionStateV1 {
  return {
    schemaVersion: 1,
    records: state.records.map((record) => ({
      ...record,
      ...(record.replacement === undefined ? {} : { replacement: { ...record.replacement } }),
      ...(record.providerPurge === undefined ? {} : { providerPurge: { ...record.providerPurge } }),
    })),
  }
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
}

function validProviderPurge(value: unknown): value is SessionProviderPurgeHandle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const handle = value as Partial<SessionProviderPurgeHandle>
  if (typeof handle.adapterRevision !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/u.test(handle.adapterRevision)) return false
  if (handle.kind === 'none') {
    return Object.keys(handle).every((key) => ['kind', 'adapterRevision'].includes(key))
  }
  return handle.kind === 'resumable' && typeof handle.resourceHash === 'string' &&
    HASH.test(handle.resourceHash) && typeof handle.sealedHandle === 'string' &&
    /^[A-Za-z0-9._~-]{16,2048}$/u.test(handle.sealedHandle) &&
    Object.keys(handle).every((key) =>
      ['kind', 'adapterRevision', 'resourceHash', 'sealedHandle'].includes(key))
}

function validate(value: unknown): SessionDeletionStateV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('SESSION_DELETION_STATE_CORRUPT')
  }
  const state = value as Partial<SessionDeletionStateV1>
  if (state.schemaVersion !== 1 || !Array.isArray(state.records) ||
    Object.keys(state).some((key) => !['schemaVersion', 'records'].includes(key))) {
    throw new Error('SESSION_DELETION_STATE_CORRUPT')
  }
  const operations = new Set<string>()
  const targets = new Set<string>()
  for (const raw of state.records) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('SESSION_DELETION_STATE_CORRUPT')
    }
    const record = raw as Partial<SessionDeletionRecordV1>
    const target = `${record.operatorId}\0${record.profileId}\0${record.projectId}\0${record.sessionId}`
    const replacement = record.replacement
    const phase = record.phase as SessionDeletionPhase
    const commonInvalid = record.schemaVersion !== 1 || typeof record.operatorId !== 'string' ||
      typeof record.profileId !== 'string' || typeof record.projectId !== 'string' ||
      typeof record.sessionId !== 'string' || !ID.test(record.sessionId) ||
      typeof record.operationHash !== 'string' || !HASH.test(record.operationHash) ||
      operations.has(record.operationHash) || targets.has(target) ||
      !validIso(record.deletedAt) || !PHASES.has(phase)
    const replacementInvalid = replacement !== undefined &&
      (typeof replacement !== 'object' || replacement === null ||
        typeof replacement.sessionId !== 'string' || !ID.test(replacement.sessionId) ||
        typeof replacement.createKeyHash !== 'string' || !HASH.test(replacement.createKeyHash) ||
        replacement.name !== 'Новая сессия' ||
        Object.keys(replacement).some((key) =>
          !['sessionId', 'createKeyHash', 'name'].includes(key)))
    const terminal = TERMINAL_PHASES.has(phase)
    const shapeInvalid = terminal
      ? typeof record.restartRequired !== 'boolean' ||
        (record.restartRequired === true
          ? !Number.isSafeInteger(record.restartUpdateId) || (record.restartUpdateId ?? -1) < 0
          : record.restartUpdateId !== undefined) ||
        !Number.isSafeInteger(record.purgeRevision) || (record.purgeRevision ?? 0) < 1 ||
        !validIso(record.purgedAt) ||
        Object.keys(record).some((key) => ![
          'schemaVersion', 'operationHash', 'operatorId', 'profileId', 'projectId',
          'sessionId', 'deletedAt', 'restartRequired', 'restartUpdateId',
          'purgeRevision', 'purgedAt', 'phase',
        ].includes(key))
      : !Number.isSafeInteger(record.expectedGeneration) ||
        (record.expectedGeneration ?? 0) < 1 ||
        !Number.isSafeInteger(record.sourceUpdateId) || (record.sourceUpdateId ?? -1) < 0 ||
        typeof record.transcriptHead !== 'string' || !HASH.test(record.transcriptHead) ||
        typeof record.activeAtPrepare !== 'boolean' || !validProviderPurge(record.providerPurge) ||
      (record.selectionGeneration !== undefined &&
        (!Number.isSafeInteger(record.selectionGeneration) || record.selectionGeneration < 1)) ||
      Object.keys(record).some((key) => ![
        'schemaVersion', 'operationHash', 'operatorId', 'profileId', 'projectId',
        'sessionId', 'expectedGeneration', 'sourceUpdateId', 'transcriptHead',
        'activeAtPrepare', 'providerPurge', 'replacement', 'selectionGeneration',
        'deletedAt', 'phase',
      ].includes(key))
    if (commonInvalid || replacementInvalid || shapeInvalid) {
      throw new Error('SESSION_DELETION_STATE_CORRUPT')
    }
    operations.add(record.operationHash as string)
    targets.add(target)
  }
  return clone(state as SessionDeletionStateV1)
}

function samePrepared(
  current: SessionDeletionRecordV1,
  incoming: Omit<PreparedSessionDeletionRecord, 'schemaVersion' | 'phase'>,
): boolean {
  return current.operationHash === incoming.operationHash &&
    current.operatorId === incoming.operatorId && current.profileId === incoming.profileId &&
    current.projectId === incoming.projectId && current.sessionId === incoming.sessionId &&
    current.expectedGeneration === incoming.expectedGeneration &&
    current.sourceUpdateId === incoming.sourceUpdateId &&
    current.transcriptHead === incoming.transcriptHead &&
    current.activeAtPrepare === incoming.activeAtPrepare &&
    JSON.stringify(current.providerPurge) === JSON.stringify(incoming.providerPurge) &&
    current.deletedAt === incoming.deletedAt &&
    JSON.stringify(current.replacement) === JSON.stringify(incoming.replacement)
}

export function makeSessionDeletionJournal(input: {
  persistence: SessionDeletionPersistence
}): SessionDeletionJournal {
  let state = validate(input.persistence.load())
  const publish = (candidate: SessionDeletionStateV1): void => {
    const next = validate(candidate)
    input.persistence.save(next)
    state = next
  }
  return Object.freeze<SessionDeletionJournal>({
    prepare(raw) {
      const existing = state.records.find((record) =>
        record.operationHash === raw.operationHash ||
        (record.operatorId === raw.operatorId && record.profileId === raw.profileId &&
          record.projectId === raw.projectId && record.sessionId === raw.sessionId))
      if (existing !== undefined) {
        if (!samePrepared(existing, raw)) throw new Error('SESSION_DELETION_IDENTITY_CONFLICT')
        return clone({ schemaVersion: 1, records: [existing] }).records[0]! as
          PreparedSessionDeletionRecord
      }
      const record = validate({
        schemaVersion: 1,
        records: [{ schemaVersion: 1, ...raw, phase: 'prepared-and-fenced' }],
      }).records[0]!
      publish({ ...state, records: [...state.records, record] })
      return clone({ schemaVersion: 1, records: [record] }).records[0]! as
        PreparedSessionDeletionRecord
    },
    advance(operationHash, expectedPhase, phase, patch = {}) {
      const current = state.records.find((record) => record.operationHash === operationHash)
      if (current === undefined) throw new Error('SESSION_DELETION_NOT_FOUND')
      if (current.phase !== expectedPhase) throw new Error('SESSION_DELETION_PHASE_CONFLICT')
      if (TRANSITIONS.get(expectedPhase) !== phase) {
        throw new Error('SESSION_DELETION_TRANSITION_INVALID')
      }
      const next = { ...current, ...patch, phase }
      publish({
        ...state,
        records: state.records.map((record) =>
          record.operationHash === operationHash ? next : record),
      })
      return clone({ schemaVersion: 1, records: [next] }).records[0]!
    },
    complete(operationHash, expectedPhase, purgedAt) {
      const current = state.records.find((record) => record.operationHash === operationHash)
      if (current === undefined) throw new Error('SESSION_DELETION_NOT_FOUND')
      if (current.phase !== expectedPhase || typeof current.activeAtPrepare !== 'boolean' ||
        !validIso(purgedAt)) {
        throw new Error('SESSION_DELETION_PHASE_CONFLICT')
      }
      const next: SessionDeletionRecordV1 = {
        schemaVersion: 1,
        operationHash: current.operationHash,
        operatorId: current.operatorId,
        profileId: current.profileId,
        projectId: current.projectId,
        sessionId: current.sessionId,
        deletedAt: current.deletedAt,
        restartRequired: current.activeAtPrepare,
        ...(current.activeAtPrepare ? { restartUpdateId: current.sourceUpdateId } : {}),
        purgeRevision: 1,
        purgedAt,
        phase: 'terminal',
      }
      publish({
        ...state,
        records: state.records.map((record) =>
          record.operationHash === operationHash ? next : record),
      })
      return { ...next }
    },
    get(operationHash) {
      const record = state.records.find((item) => item.operationHash === operationHash)
      return record === undefined ? null : clone({ schemaVersion: 1, records: [record] }).records[0]!
    },
    isFenced(target) {
      return state.records.some((record) => record.operatorId === target.operatorId &&
        record.profileId === target.profileId && record.projectId === target.projectId &&
        record.sessionId === target.sessionId)
    },
    snapshot: () => clone(state),
  })
}

export function makeMemorySessionDeletionPersistence(input: {
  initial?: SessionDeletionStateV1
  save?: (state: SessionDeletionStateV1) => void
} = {}): SessionDeletionPersistence {
  let state = validate(input.initial ?? { schemaVersion: 1, records: [] })
  return {
    load: () => clone(state),
    save(candidate) {
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

function cleanupSessionDeletionTemps(path: string): void {
  const directory = dirname(path)
  const prefix = `${basename(path)}.tmp-`
  let removed = false
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue
    if (!/^[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      name.slice(prefix.length),
    )) throw new Error('SESSION_DELETION_STATE_CORRUPT')
    const temporary = join(directory, name)
    const info = lstatSync(temporary)
    const owner = typeof process.getuid === 'function' ? process.getuid() : info.uid
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== owner ||
      (info.mode & 0o077) !== 0 || info.size > MAX_BYTES) {
      throw new Error('SESSION_DELETION_STATE_CORRUPT')
    }
    unlinkSync(temporary)
    removed = true
  }
  if (removed) syncPath(directory)
}

export function makeNodeSessionDeletionPersistence(path: string): SessionDeletionPersistence {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  cleanupSessionDeletionTemps(path)
  let initial: SessionDeletionStateV1 = { schemaVersion: 1, records: [] }
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
      throw new Error('SESSION_DELETION_STATE_CORRUPT')
    }
    try { initial = validate(JSON.parse(raw) as unknown) } catch {
      throw new Error('SESSION_DELETION_STATE_CORRUPT')
    }
  }
  return makeMemorySessionDeletionPersistence({
    initial,
    save: (state) => {
      cleanupSessionDeletionTemps(path)
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
      writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      })
      syncPath(temporary)
      renameSync(temporary, path)
      syncPath(directory)
    },
  })
}

function operationIdentity(input: ProjectRegistryV2Owner & {
  projectId: string
  sessionId: string
  sourceUpdateId: number
  transcriptHead: string
}): {
  operationHash: string
  replacement: NonNullable<SessionDeletionRecordV1['replacement']>
} {
  const operationHash = createHash('sha256')
    .update('aisy-session-deletion/v1')
    .update('\0').update(input.operatorId)
    .update('\0').update(input.profileId)
    .update('\0').update(input.projectId)
    .update('\0').update(input.sessionId)
    .update('\0').update(String(input.sourceUpdateId))
    .update('\0').update(input.transcriptHead)
    .digest('hex')
  const createKeyHash = createHash('sha256')
    .update('aisy-session-deletion-replacement/v1')
    .update('\0').update(operationHash)
    .digest('hex')
  return {
    operationHash,
    replacement: {
      sessionId: `session-${createKeyHash.slice(0, 32)}`,
      createKeyHash,
      name: 'Новая сессия',
    },
  }
}

function selectionFromSnapshot(
  registry: ProjectRegistryV2,
  owner: ProjectRegistryV2Owner,
): ProjectSelectionV2 {
  const found = registry.snapshot().selections.find((selection) =>
    selection.operatorId === owner.operatorId && selection.profileId === owner.profileId)
  if (found === undefined) throw new Error('SESSION_DELETION_SELECTION_MISSING')
  return { ...found }
}

async function publishReplacementSelection(input: {
  record: SessionDeletionRecordV1
  registry: ProjectRegistryV2
  service: Pick<ProjectService, 'runSessionDeletionTransition'>
  journal: SessionDeletionJournal
  creation: Pick<SessionCreationCoordinator, 'prepareExternal' | 'completeExternal'>
}): Promise<SessionDeletionRecordV1> {
  const target = {
    operatorId: input.record.operatorId,
    profileId: input.record.profileId,
    projectId: input.record.projectId,
    sessionId: input.record.sessionId,
  }
  return input.service.runSessionDeletionTransition(target, () => {
    const record = input.record
    if (record.expectedGeneration === undefined) {
      throw new Error('SESSION_DELETION_STATE_CORRUPT')
    }
    if (record.replacement !== undefined) {
      input.creation.prepareExternal({
        ...target,
        sessionId: record.replacement.sessionId,
        expectedGeneration: record.expectedGeneration,
        createKeyHash: record.replacement.createKeyHash,
        name: record.replacement.name,
        labelKind: 'temporary',
      })
    }
    let selection: ProjectSelectionV2
    try {
      const result = input.registry.selectSessionDeletionReplacement({
        ...target,
        expectedGeneration: record.expectedGeneration,
        ...(record.replacement === undefined ? {} : { replacement: record.replacement }),
      })
      selection = result.selection
    } catch (error) {
      const current = selectionFromSnapshot(input.registry, target)
      if (!(error instanceof ProjectRegistryV2Error) || error.code !== 'STALE_GENERATION' ||
        (current.projectId === target.projectId && current.sessionId === target.sessionId)) {
        throw error
      }
      selection = current
    }
    if (record.replacement !== undefined && input.registry.snapshot().sessions.some((session) =>
      session.id === record.replacement!.sessionId &&
      session.createKeyHash === record.replacement!.createKeyHash)) {
      input.creation.completeExternal(record.replacement.createKeyHash)
    }
    return input.journal.advance(
      record.operationHash,
      record.phase,
      'replacement-selected',
      { selectionGeneration: selection.generation },
    )
  })
}

/**
 * Startup barrier: repairs only the bounded selection publication before any
 * static binding, turn lease, transport or background consumer can start.
 */
export async function repairSessionDeletionSelections(input: {
  registry: ProjectRegistryV2
  service: Pick<ProjectService, 'runSessionDeletionTransition'>
  journal: SessionDeletionJournal
  creation: Pick<SessionCreationCoordinator, 'prepareExternal' | 'completeExternal'>
}): Promise<{ recovered: number }> {
  let recovered = 0
  for (const record of input.journal.snapshot().records) {
    if (record.phase !== 'prepared-and-fenced') continue
    await publishReplacementSelection({ ...input, record })
    recovered += 1
  }
  return { recovered }
}

export function makeSessionDeletionCoordinator(input: {
  registry: ProjectRegistryV2
  service: Pick<ProjectService, 'runSessionDeletionTransition'>
  journal: SessionDeletionJournal
  creation: Pick<SessionCreationCoordinator, 'prepareExternal' | 'completeExternal'>
  labels: Pick<SessionLabelStore, 'remove'>
  transcript: NodeSessionTranscriptMaintenance
  activity: { assertIdle(target: ProjectRegistryV2Owner & { projectId: string; sessionId: string }): void }
  attachments: {
    assertIdle(target: ProjectRegistryV2Owner & { projectId: string; sessionId: string }): void
    purgeSession(
      target: ProjectRegistryV2Owner & { projectId: string; sessionId: string },
    ): void | Promise<void>
  }
  provider: {
    preflight(target: ProjectRegistryV2Owner & {
      projectId: string
      sessionId: string
    }): SessionProviderPurgeHandle
    purge(
      target: ProjectRegistryV2Owner & { projectId: string; sessionId: string },
      handle: SessionProviderPurgeHandle,
      operationHash: string,
    ): void | Promise<void>
  }
  dependants: {
    settle(
      target: ProjectRegistryV2Owner & { projectId: string; sessionId: string },
      operationHash: string,
    ): void | Promise<void>
  }
  restart: {
    assertAvailable(): void
    prepare(authority: { operationHash: string; updateId: number }): void | Promise<void>
  }
  nowIso?: () => string
}): SessionDeletionCoordinator {
  const nowIso = input.nowIso ?? (() => new Date().toISOString())
  const resume = async (initial: SessionDeletionRecordV1): Promise<SessionDeletionRecordV1> => {
    let record = initial
    const target = {
      operatorId: record.operatorId,
      profileId: record.profileId,
      projectId: record.projectId,
      sessionId: record.sessionId,
    }
    while (true) {
      if (record.phase === 'prepared-and-fenced') {
        record = await publishReplacementSelection({ ...input, record })
        continue
      }
      if (record.phase === 'replacement-selected') {
        await input.dependants.settle(target, record.operationHash)
        record = input.journal.advance(record.operationHash, record.phase, 'dependants-settled')
        continue
      }
      if (record.phase === 'dependants-settled') {
        record = input.journal.advance(record.operationHash, record.phase, 'provider-purge-pending')
        continue
      }
      if (record.phase === 'provider-purge-pending') {
        if (record.providerPurge === undefined) throw new Error('SESSION_DELETION_STATE_CORRUPT')
        await input.provider.purge(target, record.providerPurge, record.operationHash)
        record = input.journal.advance(record.operationHash, record.phase, 'provider-purged')
        continue
      }
      if (record.phase === 'provider-purged') {
        record = input.journal.advance(record.operationHash, record.phase, 'transcript-rewrite-prepared')
        continue
      }
      if (record.phase === 'transcript-rewrite-prepared') {
        let rewritten: SessionDeletionRecordV1 | null = null
        await input.transcript.purgeSession(record.sessionId, () => {
          rewritten = input.journal.advance(
            record.operationHash,
            record.phase,
            'transcript-rewritten',
          )
        })
        if (rewritten === null) throw new Error('SESSION_DELETION_TRANSCRIPT_PHASE_MISSING')
        record = rewritten
        continue
      }
      if (record.phase === 'transcript-rewritten') {
        const deletionGeneration = record.selectionGeneration ?? record.expectedGeneration
        if (deletionGeneration === undefined) throw new Error('SESSION_DELETION_STATE_CORRUPT')
        try {
          input.registry.deleteSession({
            ...target,
            expectedGeneration: deletionGeneration,
          })
        } catch (error) {
          if (!(error instanceof ProjectRegistryV2Error) || error.code !== 'SESSION_NOT_FOUND') {
            throw error
          }
        }
        record = input.journal.advance(record.operationHash, record.phase, 'registry-removed')
        continue
      }
      if (record.phase === 'registry-removed') {
        await input.attachments.purgeSession(target)
        input.labels.remove(record.sessionId)
        await input.transcript.removeSessionControls(record.sessionId)
        record = input.journal.advance(record.operationHash, record.phase, 'target-controls-removed')
        continue
      }
      if (record.phase === 'target-controls-removed') {
        record = input.journal.complete(record.operationHash, record.phase, nowIso())
        continue
      }
      if (record.phase === 'terminal' && record.restartRequired === true) {
        if (record.restartUpdateId === undefined) {
          throw new Error('SESSION_DELETION_STATE_CORRUPT')
        }
        await input.restart.prepare({
          operationHash: record.operationHash,
          updateId: record.restartUpdateId,
        })
        record = input.journal.advance(record.operationHash, record.phase, 'restart-requested')
      } else if (record.phase === 'restart-requested' && record.restartRequired === true) {
        if (record.restartUpdateId === undefined) {
          throw new Error('SESSION_DELETION_STATE_CORRUPT')
        }
        await input.restart.prepare({
          operationHash: record.operationHash,
          updateId: record.restartUpdateId,
        })
      }
      return record
    }
  }

  return Object.freeze<SessionDeletionCoordinator>({
    async deleteConfirmed(raw) {
      if (!Number.isSafeInteger(raw.sourceUpdateId) || raw.sourceUpdateId < 0 ||
        !HASH.test(raw.transcriptHead)) {
        throw new Error('SESSION_DELETION_AUTHORITY_INVALID')
      }
      const target = {
        operatorId: raw.operatorId,
        profileId: raw.profileId,
        projectId: raw.projectId,
        sessionId: raw.sessionId,
      }
      const identity = operationIdentity(raw)
      const existing = input.journal.get(identity.operationHash)
      if (existing !== null) return resume(existing)
      const prepared = await input.service.runSessionDeletionTransition(target, async () => {
        input.registry.getSession(target)
        input.activity.assertIdle(target)
        input.attachments.assertIdle(target)
        const providerPurge = input.provider.preflight(target)
        if (!validProviderPurge(providerPurge)) {
          throw new Error('SESSION_DELETION_PROVIDER_AUTHORITY_INVALID')
        }
        const currentHead = await input.transcript.currentHead(raw.sessionId)
        if (currentHead !== raw.transcriptHead) {
          throw new Error('SESSION_DELETION_AUTHORITY_STALE')
        }
        const active = selectionFromSnapshot(input.registry, raw)
        if (active.generation !== raw.expectedGeneration) {
          throw new ProjectRegistryV2Error('STALE_GENERATION')
        }
        const activeAtPrepare = active.projectId === raw.projectId &&
          active.sessionId === raw.sessionId
        if (activeAtPrepare) input.restart.assertAvailable()
        const otherActive = input.registry.searchSessions({
          ...raw, query: '', includeArchived: false,
        }).some((session) => session.id !== raw.sessionId)
        const fenced = input.journal.prepare({
          operationHash: identity.operationHash,
          ...target,
          expectedGeneration: raw.expectedGeneration,
          sourceUpdateId: raw.sourceUpdateId,
          transcriptHead: raw.transcriptHead,
          activeAtPrepare,
          providerPurge,
          ...(!otherActive && activeAtPrepare ? { replacement: identity.replacement } : {}),
          deletedAt: nowIso(),
        })
        if (fenced.replacement !== undefined) {
          input.creation.prepareExternal({
            ...target,
            sessionId: fenced.replacement.sessionId,
            expectedGeneration: fenced.expectedGeneration,
            createKeyHash: fenced.replacement.createKeyHash,
            name: fenced.replacement.name,
            labelKind: 'temporary',
          })
        }
        const replacement = input.registry.selectSessionDeletionReplacement({
          ...target,
          expectedGeneration: fenced.expectedGeneration,
          ...(fenced.replacement === undefined ? {} : { replacement: fenced.replacement }),
        })
        if (fenced.replacement !== undefined) {
          input.creation.completeExternal(fenced.replacement.createKeyHash)
        }
        return input.journal.advance(
          fenced.operationHash,
          fenced.phase,
          'replacement-selected',
          { selectionGeneration: replacement.selection.generation },
        )
      })
      return resume(prepared)
    },
    async repair() {
      let recovered = 0
      for (const record of input.journal.snapshot().records) {
        if ((record.phase === 'terminal' && record.restartRequired === false) ||
          record.phase === 'restart-acknowledged') continue
        await resume(record)
        recovered += 1
      }
      return { recovered }
    },
    acknowledgeRestart(operationHash) {
      const record = input.journal.get(operationHash)
      if (record === null) throw new Error('SESSION_DELETION_NOT_FOUND')
      if (record.phase === 'restart-acknowledged') return record
      if (record.phase !== 'restart-requested' || record.restartRequired !== true) {
        throw new Error('SESSION_DELETION_RESTART_NOT_REQUESTED')
      }
      return input.journal.advance(
        operationHash,
        'restart-requested',
        'restart-acknowledged',
      )
    },
  })
}

/** Returns deletion authority only for the exact code-owned restart reason. */
export function sessionDeletionOperationFromRestartReason(reason: string): string | null {
  return DELETION_RESTART_REASON.exec(reason)?.[1] ?? null
}

export function assertExactSessionDeletionRestartIntent(
  intent: Readonly<{ reason: string; activeTurns: number }>,
  expectedReason: string,
): void {
  if (intent.reason !== expectedReason || intent.activeTurns !== 0 ||
    sessionDeletionOperationFromRestartReason(intent.reason) === null) {
    throw new Error('SESSION_DELETION_RESTART_IDENTITY_MISMATCH')
  }
}

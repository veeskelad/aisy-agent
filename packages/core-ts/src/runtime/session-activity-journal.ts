import { createHash } from 'node:crypto'

import type {
  ContextSpan,
  TurnResult,
} from '../agent-loop/types.js'
import {
  computeTranscriptRowHash,
  type TranscriptBinding,
  type TranscriptEnvelope,
} from './session-transcript.js'
import { transcriptTurnEventId } from './session-transcript-recorder.js'

const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_SPAN_BYTES = 1024 * 1024
const MAX_TERMINAL_REPLY_BYTES = 1024 * 1024
const MAX_DISPATCH_BYTES = 4 * 1024 * 1024
export const SESSION_ACTIVITY_MAX_CONTROL_BYTES = 8 * 1024 * 1024
const MAX_PENDING_INGRESS = 256
const MAX_INGRESS = 512
const MAX_SPANS = 64
const MAX_DISPATCHES = 256
const MAX_NONTERMINAL_DISPATCHES = 64
const MAX_EVIDENCE = 256
const MAX_TRANSCRIPT_ORDINAL = 2048
const ZERO_HASH = '0'.repeat(64)

const BINDING_KEYS = new Set(['operatorId', 'profileId', 'projectId', 'sessionId'])
const SPAN_KEYS = new Set(['role', 'provenance', 'text'])
const INGRESS_KEYS = new Set([
  'schemaVersion', 'ingressId', 'binding', 'chatBindingHash', 'updateId',
  'messageTs', 'acceptedAt', 'span', 'state', 'dispatchId',
])
const TELEGRAM_SOURCE_KEYS = new Set(['kind', 'chatBindingHash', 'updateIds'])
const BACKGROUND_SOURCE_KEYS = new Set(['kind', 'sourceId', 'occurrenceId'])
const EVIDENCE_KEYS = new Set(['ordinal', 'eventId', 'rowHash'])
const TERMINAL_KEYS = new Set([
  'reply', 'state', 'haltReason', 'planHash', 'narrowed', 'usage',
  'actionContractKind', 'actionStatus',
])
const USAGE_KEYS = new Set(['inputTokens', 'outputTokens', 'dollars'])
const DISPATCH_KEYS = new Set([
  'schemaVersion', 'dispatchId', 'binding', 'source', 'turnId', 'turnTs',
  'spans', 'revision', 'phase', 'operationSeq', 'transcriptOrdinal',
  'transcriptEvidence', 'requestHash', 'effectiveToolName', 'terminal',
  'interruptionCode', 'createdAt', 'updatedAt',
])
const STATE_KEYS = new Set([
  'schemaVersion', 'binding', 'revision', 'ingress', 'dispatches', 'checksum',
])

export type ActivityBinding = TranscriptBinding

export type ActivitySource =
  | {
      kind: 'telegram'
      chatBindingHash: string
      updateIds: number[]
    }
  | {
      kind: 'trigger' | 'goal' | 'nightly'
      sourceId: string
      occurrenceId: string
    }

export interface TelegramIngressV1 {
  schemaVersion: 1
  ingressId: string
  binding: ActivityBinding
  chatBindingHash: string
  updateId: number
  messageTs: string
  acceptedAt: string
  span: ContextSpan
  state: 'pending' | 'sealed'
  dispatchId?: string
}

export type TurnDispatchPhase =
  | 'prepared'
  | 'provider-pending'
  | 'provider-recorded'
  | 'tool-pending'
  | 'tool-recorded'
  | 'terminal'
  | 'interrupted'

export interface TranscriptActivityEvidence {
  ordinal: number
  eventId: string
  rowHash: string
}

export interface TurnDispatchV1 {
  schemaVersion: 1
  dispatchId: string
  binding: ActivityBinding
  source: ActivitySource
  turnId: string
  turnTs: string
  spans: ContextSpan[]
  revision: number
  phase: TurnDispatchPhase
  operationSeq: number
  transcriptOrdinal: number
  transcriptEvidence: TranscriptActivityEvidence[]
  requestHash?: string
  effectiveToolName?: string
  terminal?: TurnResult
  interruptionCode?: 'PROVIDER_OUTCOME_UNCERTAIN' | 'TOOL_OUTCOME_UNCERTAIN'
  createdAt: string
  updatedAt: string
}

export interface SessionActivityJournalStateV1 {
  schemaVersion: 1
  binding: ActivityBinding
  revision: number
  ingress: TelegramIngressV1[]
  dispatches: TurnDispatchV1[]
  checksum: string
}

export type SessionActivityPersistenceLoad =
  | { status: 'missing' }
  | { status: 'ready'; value: unknown }
  | { status: 'quarantined' }

export type SessionActivityQuarantineReason =
  | 'invalid-state'
  | 'binding-mismatch'
  | 'identity-conflict'
  | 'cas-conflict'

export interface SessionActivityJournalPersistencePort {
  load(binding: ActivityBinding): Promise<SessionActivityPersistenceLoad>
  commit(input: {
    binding: ActivityBinding
    expectedRevision: number | null
    state: SessionActivityJournalStateV1
  }): Promise<void>
  quarantine(binding: ActivityBinding, reason: SessionActivityQuarantineReason): Promise<void>
}

export class SessionActivityPersistenceError extends Error {
  constructor(readonly code: 'cas-conflict' | 'unavailable') {
    super(`session activity persistence failed: ${code}`)
    this.name = 'SessionActivityPersistenceError'
  }
}

export type ActivityRecovery =
  | { kind: 'ready'; dispatch: TurnDispatchV1 }
  | { kind: 'completed'; result: TurnResult }
  | {
      kind: 'interrupted'
      code:
        | 'PROVIDER_OUTCOME_UNCERTAIN'
        | 'TOOL_OUTCOME_UNCERTAIN'
        | 'TRANSCRIPT_DIVERGED'
        | 'ACTIVITY_QUARANTINED'
    }

export interface SessionActivityJournal {
  acceptTelegram(input: {
    binding: ActivityBinding
    chatBindingHash: string
    updateId: number
    messageTs: string
    span: ContextSpan
  }): Promise<{ status: 'accepted' | 'duplicate'; ingressId: string }>
  sealTelegram(input: {
    binding: ActivityBinding
    chatBindingHash: string
    orderedIngressIds: string[]
    sealedAt: string
  }): Promise<{ status: 'prepared' | 'duplicate'; dispatch: TurnDispatchV1 }>
  prepareBackground(input: {
    binding: ActivityBinding
    source: Extract<ActivitySource, { kind: 'trigger' | 'goal' | 'nightly' }>
    spans: ContextSpan[]
    occurredAt: string
  }): Promise<{ status: 'prepared' | 'duplicate'; dispatch: TurnDispatchV1 }>
  transition(input: {
    binding: ActivityBinding
    dispatchId: string
    expectedRevision: number
    phase: TurnDispatchPhase
    operationSeq: number
    transcriptOrdinal: number
    evidence?: TranscriptActivityEvidence
    requestHash?: string
    effectiveToolName?: string
    terminal?: TurnResult
    at: string
  }): Promise<TurnDispatchV1>
  recover(input: {
    binding: ActivityBinding
    dispatchId: string
    transcript: TranscriptEnvelope[]
  }): Promise<ActivityRecovery>
}

export class SessionActivityJournalError extends Error {
  constructor(
    readonly code:
      | 'invalid-input'
      | 'bounds-exceeded'
      | 'not-found'
      | 'identity-conflict'
      | 'invalid-transition'
      | 'cas-conflict'
      | 'persistence-unavailable'
      | 'quarantined',
  ) {
    super(`session activity journal rejected: ${code}`)
    this.name = 'SessionActivityJournalError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).length <= keys.size && Object.keys(value).every(key => keys.has(key))
}

function exactRequiredKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  return exactKeys(value, keys) && required.every(key => Object.hasOwn(value, key))
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) &&
    new Date(value).toISOString() === value
}

function validBinding(value: unknown): value is ActivityBinding {
  if (!record(value) || !exactRequiredKeys(value, BINDING_KEYS, [...BINDING_KEYS])) return false
  return [...BINDING_KEYS].every(key => typeof value[key] === 'string' && ID.test(value[key] as string))
}

function sameBinding(a: ActivityBinding, b: ActivityBinding): boolean {
  return a.operatorId === b.operatorId && a.profileId === b.profileId &&
    a.projectId === b.projectId && a.sessionId === b.sessionId
}

function validSpan(value: unknown): value is ContextSpan {
  if (!record(value) || !exactRequiredKeys(value, SPAN_KEYS, [...SPAN_KEYS])) return false
  return ['system', 'user', 'assistant', 'tool'].includes(String(value['role'])) &&
    (value['provenance'] === 'operator' || value['provenance'] === 'untrusted') &&
    typeof value['text'] === 'string' && Buffer.byteLength(value['text'], 'utf8') <= MAX_SPAN_BYTES
}

function sameSpan(a: ContextSpan, b: ContextSpan): boolean {
  return a.role === b.role && a.provenance === b.provenance && a.text === b.text
}

function validSource(value: unknown): value is ActivitySource {
  if (!record(value)) return false
  if (value['kind'] === 'telegram') {
    return exactRequiredKeys(value, TELEGRAM_SOURCE_KEYS, [...TELEGRAM_SOURCE_KEYS]) &&
      typeof value['chatBindingHash'] === 'string' && HASH.test(value['chatBindingHash']) &&
      Array.isArray(value['updateIds']) && value['updateIds'].length > 0 &&
      value['updateIds'].length <= MAX_PENDING_INGRESS &&
      value['updateIds'].every(item => Number.isSafeInteger(item) && item >= 0) &&
      new Set(value['updateIds']).size === value['updateIds'].length
  }
  return (value['kind'] === 'trigger' || value['kind'] === 'goal' || value['kind'] === 'nightly') &&
    exactRequiredKeys(value, BACKGROUND_SOURCE_KEYS, [...BACKGROUND_SOURCE_KEYS]) &&
    typeof value['sourceId'] === 'string' && ID.test(value['sourceId']) &&
    typeof value['occurrenceId'] === 'string' && ID.test(value['occurrenceId'])
}

function validUsage(value: unknown): boolean {
  if (!record(value) || !exactRequiredKeys(value, USAGE_KEYS, [...USAGE_KEYS])) return false
  return Number.isSafeInteger(value['inputTokens']) && Number(value['inputTokens']) >= 0 &&
    Number.isSafeInteger(value['outputTokens']) && Number(value['outputTokens']) >= 0 &&
    typeof value['dollars'] === 'number' && Number.isFinite(value['dollars']) && value['dollars'] >= 0
}

function validTerminal(value: unknown): value is TurnResult {
  if (!record(value) || !exactRequiredKeys(value, TERMINAL_KEYS, ['reply', 'state'])) return false
  if (typeof value['reply'] !== 'string' ||
    Buffer.byteLength(value['reply'], 'utf8') > MAX_TERMINAL_REPLY_BYTES ||
    !['ok', 'awaiting-clarification', 'awaiting-approval', 'halted'].includes(String(value['state']))) return false
  if (value['haltReason'] !== undefined && ![
    'loop-guardian', 'all-providers-down', 'plan-lint-failed', 'cap-exceeded',
    'budget-capped', 'stopped',
  ].includes(String(value['haltReason']))) return false
  if (value['planHash'] !== undefined &&
    (typeof value['planHash'] !== 'string' || !HASH.test(value['planHash']))) return false
  if (value['narrowed'] !== undefined && typeof value['narrowed'] !== 'boolean') return false
  if (value['usage'] !== undefined && !validUsage(value['usage'])) return false
  if (value['actionContractKind'] !== undefined && ![
    'inspect-required', 'mutate-required', 'delegate-required',
  ].includes(String(value['actionContractKind']))) return false
  if (value['actionStatus'] !== undefined &&
    value['actionStatus'] !== 'verified' && value['actionStatus'] !== 'unverified') return false
  return true
}

function validEvidence(value: unknown): value is TranscriptActivityEvidence {
  return record(value) && exactRequiredKeys(value, EVIDENCE_KEYS, [...EVIDENCE_KEYS]) &&
    Number.isSafeInteger(value['ordinal']) && Number(value['ordinal']) >= 1 &&
    Number(value['ordinal']) <= MAX_TRANSCRIPT_ORDINAL &&
    typeof value['eventId'] === 'string' && HASH.test(value['eventId']) &&
    typeof value['rowHash'] === 'string' && HASH.test(value['rowHash'])
}

function validIngress(value: unknown, binding: ActivityBinding): value is TelegramIngressV1 {
  if (!record(value) || !exactRequiredKeys(value, INGRESS_KEYS, [
    'schemaVersion', 'ingressId', 'binding', 'chatBindingHash', 'updateId',
    'messageTs', 'acceptedAt', 'span', 'state',
  ])) return false
  if (value['schemaVersion'] !== 1 || typeof value['ingressId'] !== 'string' ||
    !HASH.test(value['ingressId']) || !validBinding(value['binding']) ||
    !sameBinding(value['binding'], binding) || typeof value['chatBindingHash'] !== 'string' ||
    !HASH.test(value['chatBindingHash']) || !Number.isSafeInteger(value['updateId']) ||
    Number(value['updateId']) < 0 || !validIso(value['messageTs']) ||
    !validIso(value['acceptedAt']) || !validSpan(value['span']) ||
    (value['state'] !== 'pending' && value['state'] !== 'sealed')) return false
  if (value['ingressId'] !== telegramActivityIngressId(
    value['chatBindingHash'] as string,
    value['updateId'] as number,
  )) return false
  return value['state'] === 'pending'
    ? value['dispatchId'] === undefined
    : typeof value['dispatchId'] === 'string' && HASH.test(value['dispatchId'])
}

function validDispatch(value: unknown, binding: ActivityBinding): value is TurnDispatchV1 {
  if (!record(value) || !exactRequiredKeys(value, DISPATCH_KEYS, [
    'schemaVersion', 'dispatchId', 'binding', 'source', 'turnId', 'turnTs',
    'spans', 'revision', 'phase', 'operationSeq', 'transcriptOrdinal',
    'transcriptEvidence', 'createdAt', 'updatedAt',
  ])) return false
  if (value['schemaVersion'] !== 1 || typeof value['dispatchId'] !== 'string' ||
    !HASH.test(value['dispatchId']) || !validBinding(value['binding']) ||
    !sameBinding(value['binding'], binding) || !validSource(value['source']) ||
    typeof value['turnId'] !== 'string' || !ID.test(value['turnId']) ||
    !validIso(value['turnTs']) || !Array.isArray(value['spans']) ||
    value['spans'].length < 1 || value['spans'].length > MAX_SPANS ||
    !value['spans'].every(validSpan) || !Number.isSafeInteger(value['revision']) ||
    Number(value['revision']) < 1 || ![
      'prepared', 'provider-pending', 'provider-recorded', 'tool-pending',
      'tool-recorded', 'terminal', 'interrupted',
    ].includes(String(value['phase'])) || !Number.isSafeInteger(value['operationSeq']) ||
    Number(value['operationSeq']) < 0 || !Number.isSafeInteger(value['transcriptOrdinal']) ||
    Number(value['transcriptOrdinal']) < 0 || Number(value['transcriptOrdinal']) > MAX_TRANSCRIPT_ORDINAL ||
    !Array.isArray(value['transcriptEvidence']) || value['transcriptEvidence'].length > MAX_EVIDENCE ||
    !value['transcriptEvidence'].every(validEvidence) || !validIso(value['createdAt']) ||
    !validIso(value['updatedAt']) || Date.parse(value['updatedAt']) < Date.parse(value['createdAt'])) return false
  const evidence = value['transcriptEvidence'] as TranscriptActivityEvidence[]
  if (evidence.some((item, index) => index > 0 &&
    item.ordinal <= evidence[index - 1]!.ordinal) ||
    evidence.some(item => item.eventId !== transcriptTurnEventId(
      (value['binding'] as ActivityBinding).sessionId,
      value['turnId'] as string,
      item.ordinal,
    )) || (evidence.at(-1)?.ordinal ?? 0) > Number(value['transcriptOrdinal'])) return false
  const source = value['source'] as ActivitySource
  const persistedBinding = value['binding'] as ActivityBinding
  if (value['dispatchId'] !== dispatchIdentity(persistedBinding, source) ||
    value['turnId'] !== sessionActivityTurnId(persistedBinding, source)) return false
  if (value['requestHash'] !== undefined &&
    (typeof value['requestHash'] !== 'string' || !HASH.test(value['requestHash']))) return false
  if (value['effectiveToolName'] !== undefined &&
    (typeof value['effectiveToolName'] !== 'string' || !ID.test(value['effectiveToolName']))) return false
  if (value['terminal'] !== undefined && !validTerminal(value['terminal'])) return false
  if (value['interruptionCode'] !== undefined &&
    value['interruptionCode'] !== 'PROVIDER_OUTCOME_UNCERTAIN' &&
    value['interruptionCode'] !== 'TOOL_OUTCOME_UNCERTAIN') return false
  if (value['phase'] === 'terminal' && value['terminal'] === undefined) return false
  if (value['phase'] !== 'terminal' && value['terminal'] !== undefined) return false
  if ((value['phase'] === 'interrupted') !== (value['interruptionCode'] !== undefined)) return false
  if ((value['phase'] === 'provider-pending' || value['phase'] === 'provider-recorded') !==
    (value['requestHash'] !== undefined)) return false
  if ((value['phase'] === 'tool-pending' || value['phase'] === 'tool-recorded') !==
    (value['effectiveToolName'] !== undefined)) return false
  if ((value['phase'] === 'provider-recorded' || value['phase'] === 'tool-recorded') &&
    (evidence.length === 0 || evidence.at(-1)!.ordinal !== value['transcriptOrdinal'])) return false
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_DISPATCH_BYTES
}

function stateWithoutChecksum(state: SessionActivityJournalStateV1) {
  return {
    schemaVersion: state.schemaVersion,
    binding: state.binding,
    revision: state.revision,
    ingress: state.ingress,
    dispatches: state.dispatches,
  }
}

export function computeSessionActivityJournalChecksum(
  state: SessionActivityJournalStateV1,
): string {
  return createHash('sha256')
    .update('aisy.session-activity-journal.state.v1\0')
    .update(JSON.stringify(stateWithoutChecksum(state)), 'utf8')
    .digest('hex')
}

function validState(value: unknown, binding: ActivityBinding): value is SessionActivityJournalStateV1 {
  if (!record(value) || !exactRequiredKeys(value, STATE_KEYS, [...STATE_KEYS]) ||
    value['schemaVersion'] !== 1 || !validBinding(value['binding']) ||
    !sameBinding(value['binding'], binding) || !Number.isSafeInteger(value['revision']) ||
    Number(value['revision']) < 1 || !Array.isArray(value['ingress']) ||
    value['ingress'].length > MAX_INGRESS ||
    !value['ingress'].every(item => validIngress(item, binding)) ||
    !Array.isArray(value['dispatches']) || value['dispatches'].length > MAX_DISPATCHES ||
    !value['dispatches'].every(item => validDispatch(item, binding)) ||
    typeof value['checksum'] !== 'string' || !HASH.test(value['checksum'])) return false
  const state = value as unknown as SessionActivityJournalStateV1
  if (new Set(state.ingress.map(item => item.ingressId)).size !== state.ingress.length ||
    new Set(state.dispatches.map(item => item.dispatchId)).size !== state.dispatches.length ||
    state.ingress.filter(item => item.state === 'pending').length > MAX_PENDING_INGRESS ||
    state.dispatches.filter(item => item.phase !== 'terminal' && item.phase !== 'interrupted').length >
      MAX_NONTERMINAL_DISPATCHES ||
    state.ingress.some(item => item.state === 'sealed' &&
      !state.dispatches.some(dispatch => dispatch.dispatchId === item.dispatchId)) ||
    computeSessionActivityJournalChecksum(state) !== state.checksum ||
    Buffer.byteLength(JSON.stringify(state), 'utf8') > SESSION_ACTIVITY_MAX_CONTROL_BYTES) return false
  const telegramDispatches = state.dispatches.filter(
    (dispatch): dispatch is TurnDispatchV1 & { source: Extract<ActivitySource, { kind: 'telegram' }> } =>
      dispatch.source.kind === 'telegram',
  )
  const referencedIngress = new Set<string>()
  for (const dispatch of telegramDispatches) {
    if (dispatch.source.updateIds.length !== dispatch.spans.length) return false
    let earliest: string | null = null
    for (let index = 0; index < dispatch.source.updateIds.length; index += 1) {
      const updateId = dispatch.source.updateIds[index]!
      const matches = state.ingress.filter(item => item.state === 'sealed' &&
        item.dispatchId === dispatch.dispatchId && item.chatBindingHash === dispatch.source.chatBindingHash &&
        item.updateId === updateId)
      if (matches.length !== 1 || !sameSpan(matches[0]!.span, dispatch.spans[index]!) ||
        referencedIngress.has(matches[0]!.ingressId)) return false
      referencedIngress.add(matches[0]!.ingressId)
      if (earliest === null || Date.parse(matches[0]!.messageTs) < Date.parse(earliest)) {
        earliest = matches[0]!.messageTs
      }
    }
    if (dispatch.turnTs !== earliest) return false
  }
  if (state.ingress.some(item => item.state === 'sealed' && !referencedIngress.has(item.ingressId))) {
    return false
  }
  return true
}

function hash(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')
}

export function telegramActivityIngressId(chatBindingHash: string, updateId: number): string {
  return hash(['aisy.session-activity.telegram-ingress.v1', chatBindingHash, updateId])
}

function dispatchIdentity(binding: ActivityBinding, source: ActivitySource): string {
  return hash([
    'aisy.session-activity.dispatch.v1', binding.operatorId, binding.profileId,
    binding.projectId, binding.sessionId, source.kind,
    ...(source.kind === 'telegram'
      ? [source.chatBindingHash, source.updateIds]
      : [source.sourceId, source.occurrenceId]),
  ])
}

export function sessionActivityTurnId(binding: ActivityBinding, source: ActivitySource): string {
  return `activity:${dispatchIdentity(binding, source)}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sameSource(a: ActivitySource, b: ActivitySource): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function sameIngress(a: TelegramIngressV1, input: {
  binding: ActivityBinding
  chatBindingHash: string
  updateId: number
  messageTs: string
  span: ContextSpan
}): boolean {
  return sameBinding(a.binding, input.binding) && a.chatBindingHash === input.chatBindingHash &&
    a.updateId === input.updateId && a.messageTs === input.messageTs && sameSpan(a.span, input.span)
}

function samePreparedDispatch(a: TurnDispatchV1, b: TurnDispatchV1): boolean {
  return sameBinding(a.binding, b.binding) && sameSource(a.source, b.source) &&
    a.dispatchId === b.dispatchId && a.turnId === b.turnId && a.turnTs === b.turnTs &&
    a.spans.length === b.spans.length && a.spans.every((span, index) => sameSpan(span, b.spans[index]!))
}

function nextState(
  current: SessionActivityJournalStateV1,
  patch: Pick<SessionActivityJournalStateV1, 'ingress' | 'dispatches'>,
): SessionActivityJournalStateV1 {
  const state: SessionActivityJournalStateV1 = {
    schemaVersion: 1,
    binding: clone(current.binding),
    revision: current.revision + 1,
    ingress: clone(patch.ingress),
    dispatches: clone(patch.dispatches),
    checksum: '',
  }
  state.checksum = computeSessionActivityJournalChecksum(state)
  if (!validState(state, state.binding)) throw new SessionActivityJournalError('bounds-exceeded')
  return state
}

function firstState(binding: ActivityBinding): SessionActivityJournalStateV1 {
  const state: SessionActivityJournalStateV1 = {
    schemaVersion: 1,
    binding: clone(binding),
    revision: 1,
    ingress: [],
    dispatches: [],
    checksum: '',
  }
  state.checksum = computeSessionActivityJournalChecksum(state)
  return state
}

function validAcceptInput(input: unknown): input is Parameters<SessionActivityJournal['acceptTelegram']>[0] {
  if (!record(input) || !exactRequiredKeys(input, new Set([
    'binding', 'chatBindingHash', 'updateId', 'messageTs', 'span',
  ]), ['binding', 'chatBindingHash', 'updateId', 'messageTs', 'span'])) return false
  return validBinding(input['binding']) && typeof input['chatBindingHash'] === 'string' &&
    HASH.test(input['chatBindingHash']) && Number.isSafeInteger(input['updateId']) &&
    Number(input['updateId']) >= 0 && validIso(input['messageTs']) && validSpan(input['span'])
}

function validSealInput(input: unknown): input is Parameters<SessionActivityJournal['sealTelegram']>[0] {
  if (!record(input) || !exactRequiredKeys(input, new Set([
    'binding', 'chatBindingHash', 'orderedIngressIds', 'sealedAt',
  ]), ['binding', 'chatBindingHash', 'orderedIngressIds', 'sealedAt'])) return false
  return validBinding(input['binding']) && typeof input['chatBindingHash'] === 'string' &&
    HASH.test(input['chatBindingHash']) && Array.isArray(input['orderedIngressIds']) &&
    input['orderedIngressIds'].length > 0 && input['orderedIngressIds'].length <= MAX_PENDING_INGRESS &&
    input['orderedIngressIds'].every(item => typeof item === 'string' && HASH.test(item)) &&
    new Set(input['orderedIngressIds']).size === input['orderedIngressIds'].length &&
    validIso(input['sealedAt'])
}

function validBackgroundInput(
  input: unknown,
): input is Parameters<SessionActivityJournal['prepareBackground']>[0] {
  if (!record(input) || !exactRequiredKeys(input, new Set([
    'binding', 'source', 'spans', 'occurredAt',
  ]), ['binding', 'source', 'spans', 'occurredAt'])) return false
  return validBinding(input['binding']) && validSource(input['source']) &&
    input['source'].kind !== 'telegram' && Array.isArray(input['spans']) &&
    input['spans'].length > 0 && input['spans'].length <= MAX_SPANS &&
    input['spans'].every(validSpan) && validIso(input['occurredAt'])
}

function allowedTransition(from: TurnDispatchPhase, to: TurnDispatchPhase): boolean {
  if (from === 'terminal' || from === 'interrupted') return false
  if (to === 'interrupted') {
    return from === 'provider-pending' || from === 'provider-recorded' ||
      from === 'tool-pending' || from === 'tool-recorded'
  }
  if (from === 'prepared') return to === 'provider-pending' || to === 'terminal'
  if (from === 'provider-pending') return to === 'provider-recorded'
  if (from === 'provider-recorded') {
    return to === 'provider-pending' || to === 'tool-pending' || to === 'terminal'
  }
  if (from === 'tool-pending') return to === 'tool-recorded'
  return to === 'provider-pending' || to === 'tool-pending' || to === 'terminal'
}

function validateTranscriptChain(binding: ActivityBinding, rows: TranscriptEnvelope[]): boolean {
  let previous = ZERO_HASH
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    if (!sameBinding(row, binding) || row.sessionSeq !== index + 1 ||
      row.prevSessionHash !== previous || computeTranscriptRowHash(row) !== row.rowHash) return false
    previous = row.rowHash
  }
  return true
}

function recoveryEvidence(dispatch: TurnDispatchV1, rows: TranscriptEnvelope[]): boolean {
  if (!validateTranscriptChain(dispatch.binding, rows)) return false
  const byEvent = new Map(rows.map(row => [row.eventId, row]))
  let seenTurnRows = 0
  let missing = false
  for (let ordinal = 1; ordinal <= MAX_TRANSCRIPT_ORDINAL; ordinal += 1) {
    const eventId = transcriptTurnEventId(dispatch.binding.sessionId, dispatch.turnId, ordinal)
    const row = byEvent.get(eventId)
    if (row === undefined) {
      missing = true
      continue
    }
    if (missing || ordinal > dispatch.transcriptOrdinal && dispatch.phase !== 'prepared') return false
    if (dispatch.phase === 'prepared' && ordinal > dispatch.spans.length) return false
    if (ordinal <= dispatch.spans.length) {
      const span = dispatch.spans[ordinal - 1]!
      if (row.role !== span.role || row.provenance !== span.provenance ||
        row.content !== span.text || row.ts !== dispatch.turnTs) return false
    }
    seenTurnRows = ordinal
  }
  if (dispatch.phase !== 'prepared' && seenTurnRows !== dispatch.transcriptOrdinal) return false
  for (const evidence of dispatch.transcriptEvidence) {
    const row = byEvent.get(evidence.eventId)
    if (row === undefined || row.rowHash !== evidence.rowHash ||
      row.eventId !== transcriptTurnEventId(dispatch.binding.sessionId, dispatch.turnId, evidence.ordinal)) {
      return false
    }
  }
  return true
}

/**
 * Preview-only activity authority. It provides deterministic single-process
 * persistence semantics, but deliberately makes no singleton-writer or live
 * activation claim.
 */
export function makeSessionActivityJournal(deps: {
  persistence: SessionActivityJournalPersistencePort
  nowIso(): string
}): SessionActivityJournal {
  const queues = new Map<string, Promise<void>>()
  const serialize = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(sessionId) ?? Promise.resolve()
    const result = previous.then(work, work)
    const tail = result.then(() => {}, () => {})
    queues.set(sessionId, tail)
    return result.finally(() => { if (queues.get(sessionId) === tail) queues.delete(sessionId) })
  }
  const quarantine = async (
    binding: ActivityBinding,
    reason: SessionActivityQuarantineReason,
    code: SessionActivityJournalError['code'] = 'quarantined',
  ): Promise<never> => {
    try { await deps.persistence.quarantine(binding, reason) } catch { /* stable code stays authoritative */ }
    throw new SessionActivityJournalError(code)
  }
  const load = async (
    binding: ActivityBinding,
  ): Promise<{ state: SessionActivityJournalStateV1; existing: boolean }> => {
    const loaded = await deps.persistence.load(binding)
    if (loaded.status === 'quarantined') throw new SessionActivityJournalError('quarantined')
    if (loaded.status === 'missing') return { state: firstState(binding), existing: false }
    if (!validState(loaded.value, binding)) {
      const raw = record(loaded.value) ? loaded.value : null
      const persistedBinding = raw?.['binding']
      return quarantine(binding, validBinding(persistedBinding) && !sameBinding(persistedBinding, binding)
        ? 'binding-mismatch'
        : 'invalid-state')
    }
    return { state: clone(loaded.value), existing: true }
  }
  const commit = async (
    binding: ActivityBinding,
    current: SessionActivityJournalStateV1,
    existing: boolean,
    ingress: TelegramIngressV1[],
    dispatches: TurnDispatchV1[],
  ): Promise<SessionActivityJournalStateV1> => {
    const next = existing
      ? nextState(current, { ingress, dispatches })
      : (() => {
          const initial = firstState(binding)
          initial.ingress = clone(ingress)
          initial.dispatches = clone(dispatches)
          initial.checksum = computeSessionActivityJournalChecksum(initial)
          if (!validState(initial, binding)) throw new SessionActivityJournalError('bounds-exceeded')
          return initial
        })()
    try {
      await deps.persistence.commit({
        binding,
        expectedRevision: existing ? current.revision : null,
        state: next,
      })
    } catch (error) {
      if (error instanceof SessionActivityPersistenceError && error.code === 'cas-conflict') {
        throw new SessionActivityJournalError('cas-conflict')
      }
      throw new SessionActivityJournalError('persistence-unavailable')
    }
    return next
  }

  return {
    async acceptTelegram(input) {
      if (!validAcceptInput(input)) throw new SessionActivityJournalError('invalid-input')
      return serialize(input.binding.sessionId, async () => {
        const { state, existing } = await load(input.binding)
        const ingressId = telegramActivityIngressId(input.chatBindingHash, input.updateId)
        const current = state.ingress.find(item => item.ingressId === ingressId)
        if (current !== undefined) {
          if (!sameIngress(current, input)) {
            return quarantine(input.binding, 'identity-conflict', 'identity-conflict')
          }
          return { status: 'duplicate' as const, ingressId }
        }
        if (state.ingress.filter(item => item.state === 'pending').length >= MAX_PENDING_INGRESS ||
          state.ingress.length >= MAX_INGRESS) throw new SessionActivityJournalError('bounds-exceeded')
        const acceptedAt = deps.nowIso()
        if (!validIso(acceptedAt)) throw new SessionActivityJournalError('invalid-input')
        const ingress: TelegramIngressV1 = {
          schemaVersion: 1,
          ingressId,
          binding: clone(input.binding),
          chatBindingHash: input.chatBindingHash,
          updateId: input.updateId,
          messageTs: input.messageTs,
          acceptedAt,
          span: clone(input.span),
          state: 'pending',
        }
        await commit(input.binding, state, existing, [...state.ingress, ingress], state.dispatches)
        return { status: 'accepted' as const, ingressId }
      })
    },

    async sealTelegram(input) {
      if (!validSealInput(input)) throw new SessionActivityJournalError('invalid-input')
      return serialize(input.binding.sessionId, async () => {
        const { state, existing } = await load(input.binding)
        const items = input.orderedIngressIds.map(id => state.ingress.find(item => item.ingressId === id))
        if (items.some(item => item === undefined)) throw new SessionActivityJournalError('not-found')
        const ingress = items as TelegramIngressV1[]
        if (ingress.some(item => item.chatBindingHash !== input.chatBindingHash ||
          !sameBinding(item.binding, input.binding))) {
          return quarantine(input.binding, 'identity-conflict', 'identity-conflict')
        }
        const source: ActivitySource = {
          kind: 'telegram',
          chatBindingHash: input.chatBindingHash,
          updateIds: ingress.map(item => item.updateId),
        }
        const dispatchId = dispatchIdentity(input.binding, source)
        const turnTs = ingress.reduce((earliest, item) =>
          Date.parse(item.messageTs) < Date.parse(earliest) ? item.messageTs : earliest,
        ingress[0]!.messageTs)
        const candidate: TurnDispatchV1 = {
          schemaVersion: 1,
          dispatchId,
          binding: clone(input.binding),
          source,
          turnId: sessionActivityTurnId(input.binding, source),
          turnTs,
          spans: ingress.map(item => clone(item.span)),
          revision: 1,
          phase: 'prepared',
          operationSeq: 0,
          transcriptOrdinal: 0,
          transcriptEvidence: [],
          createdAt: input.sealedAt,
          updatedAt: input.sealedAt,
        }
        if (!validDispatch(candidate, input.binding)) throw new SessionActivityJournalError('bounds-exceeded')
        const prior = state.dispatches.find(item => item.dispatchId === dispatchId)
        if (prior !== undefined) {
          if (!samePreparedDispatch(prior, candidate) ||
            ingress.some(item => item.state !== 'sealed' || item.dispatchId !== dispatchId)) {
            return quarantine(input.binding, 'identity-conflict', 'identity-conflict')
          }
          return { status: 'duplicate' as const, dispatch: clone(prior) }
        }
        if (ingress.some(item => item.state !== 'pending') || state.dispatches.length >= MAX_DISPATCHES ||
          state.dispatches.filter(item => item.phase !== 'terminal' && item.phase !== 'interrupted').length >=
            MAX_NONTERMINAL_DISPATCHES) {
          return quarantine(input.binding, 'identity-conflict', 'identity-conflict')
        }
        const selected = new Set(input.orderedIngressIds)
        const nextIngress = state.ingress.map(item => selected.has(item.ingressId)
          ? { ...item, state: 'sealed' as const, dispatchId }
          : item)
        await commit(input.binding, state, existing, nextIngress, [...state.dispatches, candidate])
        return { status: 'prepared' as const, dispatch: clone(candidate) }
      })
    },

    async prepareBackground(input) {
      if (!validBackgroundInput(input)) throw new SessionActivityJournalError('invalid-input')
      return serialize(input.binding.sessionId, async () => {
        const { state, existing } = await load(input.binding)
        const source = clone(input.source)
        const dispatchId = dispatchIdentity(input.binding, source)
        const candidate: TurnDispatchV1 = {
          schemaVersion: 1,
          dispatchId,
          binding: clone(input.binding),
          source,
          turnId: sessionActivityTurnId(input.binding, source),
          turnTs: input.occurredAt,
          spans: clone(input.spans),
          revision: 1,
          phase: 'prepared',
          operationSeq: 0,
          transcriptOrdinal: 0,
          transcriptEvidence: [],
          createdAt: input.occurredAt,
          updatedAt: input.occurredAt,
        }
        if (!validDispatch(candidate, input.binding)) throw new SessionActivityJournalError('bounds-exceeded')
        const prior = state.dispatches.find(item => item.dispatchId === dispatchId)
        if (prior !== undefined) {
          if (!samePreparedDispatch(prior, candidate)) {
            return quarantine(input.binding, 'identity-conflict', 'identity-conflict')
          }
          return { status: 'duplicate' as const, dispatch: clone(prior) }
        }
        if (state.dispatches.length >= MAX_DISPATCHES ||
          state.dispatches.filter(item => item.phase !== 'terminal' && item.phase !== 'interrupted').length >=
            MAX_NONTERMINAL_DISPATCHES) throw new SessionActivityJournalError('bounds-exceeded')
        await commit(input.binding, state, existing, state.ingress, [...state.dispatches, candidate])
        return { status: 'prepared' as const, dispatch: clone(candidate) }
      })
    },

    async transition(input) {
      if (!record(input) || !exactRequiredKeys(input, new Set([
        'binding', 'dispatchId', 'expectedRevision', 'phase', 'operationSeq',
        'transcriptOrdinal', 'evidence', 'requestHash', 'effectiveToolName',
        'terminal', 'at',
      ]), [
        'binding', 'dispatchId', 'expectedRevision', 'phase', 'operationSeq',
        'transcriptOrdinal', 'at',
      ]) || !validBinding(input['binding']) || typeof input['dispatchId'] !== 'string' ||
        !HASH.test(input['dispatchId']) || !Number.isSafeInteger(input['expectedRevision']) ||
        Number(input['expectedRevision']) < 1 || ![
          'prepared', 'provider-pending', 'provider-recorded', 'tool-pending',
          'tool-recorded', 'terminal', 'interrupted',
        ].includes(String(input['phase'])) || !Number.isSafeInteger(input['operationSeq']) ||
        Number(input['operationSeq']) < 1 || !Number.isSafeInteger(input['transcriptOrdinal']) ||
        Number(input['transcriptOrdinal']) < 0 || Number(input['transcriptOrdinal']) > MAX_TRANSCRIPT_ORDINAL ||
        (input['evidence'] !== undefined && !validEvidence(input['evidence'])) ||
        (input['requestHash'] !== undefined &&
          (typeof input['requestHash'] !== 'string' || !HASH.test(input['requestHash']))) ||
        (input['effectiveToolName'] !== undefined &&
          (typeof input['effectiveToolName'] !== 'string' || !ID.test(input['effectiveToolName']))) ||
        (input['terminal'] !== undefined && !validTerminal(input['terminal'])) || !validIso(input['at'])) {
        throw new SessionActivityJournalError('invalid-input')
      }
      const typed = input as Parameters<SessionActivityJournal['transition']>[0]
      return serialize(typed.binding.sessionId, async () => {
        const { state, existing } = await load(typed.binding)
        if (!existing) throw new SessionActivityJournalError('not-found')
        const index = state.dispatches.findIndex(item => item.dispatchId === typed.dispatchId)
        if (index < 0) throw new SessionActivityJournalError('not-found')
        const current = state.dispatches[index]!
        const recorded = typed.phase === 'provider-recorded' || typed.phase === 'tool-recorded'
        if (current.revision !== typed.expectedRevision || typed.operationSeq !== current.operationSeq + 1) {
          throw new SessionActivityJournalError('cas-conflict')
        }
        if (!allowedTransition(current.phase, typed.phase) ||
          typed.transcriptOrdinal < current.transcriptOrdinal ||
          (recorded !== (typed.evidence !== undefined)) ||
          (recorded && (typed.evidence!.ordinal !== typed.transcriptOrdinal ||
            typed.evidence!.ordinal <= current.transcriptOrdinal ||
            typed.evidence!.eventId !== transcriptTurnEventId(
              current.binding.sessionId,
              current.turnId,
              typed.evidence!.ordinal,
            ))) ||
          ((typed.phase === 'provider-pending' || typed.phase === 'provider-recorded') !==
            (typed.requestHash !== undefined)) ||
          (typed.phase === 'provider-recorded' && typed.requestHash !== current.requestHash) ||
          ((typed.phase === 'tool-pending' || typed.phase === 'tool-recorded') !==
            (typed.effectiveToolName !== undefined)) ||
          (typed.phase === 'tool-recorded' &&
            typed.effectiveToolName !== current.effectiveToolName) ||
          (typed.phase === 'terminal' !== (typed.terminal !== undefined))) {
          throw new SessionActivityJournalError('invalid-transition')
        }
        const next: TurnDispatchV1 = {
          ...clone(current),
          revision: current.revision + 1,
          phase: typed.phase,
          operationSeq: typed.operationSeq,
          transcriptOrdinal: typed.transcriptOrdinal,
          transcriptEvidence: typed.evidence === undefined
            ? clone(current.transcriptEvidence)
            : [...clone(current.transcriptEvidence), clone(typed.evidence)],
          updatedAt: typed.at,
        }
        delete next.requestHash
        delete next.effectiveToolName
        delete next.terminal
        delete next.interruptionCode
        if (typed.requestHash !== undefined) next.requestHash = typed.requestHash
        if (typed.effectiveToolName !== undefined) next.effectiveToolName = typed.effectiveToolName
        if (typed.terminal !== undefined) next.terminal = clone(typed.terminal)
        if (typed.phase === 'interrupted') {
          next.interruptionCode = current.phase === 'tool-pending' || current.phase === 'tool-recorded'
            ? 'TOOL_OUTCOME_UNCERTAIN'
            : 'PROVIDER_OUTCOME_UNCERTAIN'
        }
        if (!validDispatch(next, typed.binding)) throw new SessionActivityJournalError('invalid-transition')
        const dispatches = [...state.dispatches]
        dispatches[index] = next
        await commit(typed.binding, state, true, state.ingress, dispatches)
        return clone(next)
      })
    },

    async recover(input) {
      if (!record(input) || !exactRequiredKeys(input, new Set([
        'binding', 'dispatchId', 'transcript',
      ]), ['binding', 'dispatchId', 'transcript']) || !validBinding(input['binding']) ||
        typeof input['dispatchId'] !== 'string' || !HASH.test(input['dispatchId']) ||
        !Array.isArray(input['transcript'])) throw new SessionActivityJournalError('invalid-input')
      const typed = input as Parameters<SessionActivityJournal['recover']>[0]
      return serialize(typed.binding.sessionId, async () => {
        let loaded: { state: SessionActivityJournalStateV1; existing: boolean }
        try { loaded = await load(typed.binding) } catch (error) {
          if (error instanceof SessionActivityJournalError && error.code === 'quarantined') {
            return { kind: 'interrupted' as const, code: 'ACTIVITY_QUARANTINED' as const }
          }
          throw error
        }
        if (!loaded.existing) throw new SessionActivityJournalError('not-found')
        const dispatch = loaded.state.dispatches.find(item => item.dispatchId === typed.dispatchId)
        if (dispatch === undefined) throw new SessionActivityJournalError('not-found')
        if (!recoveryEvidence(dispatch, typed.transcript)) {
          return { kind: 'interrupted' as const, code: 'TRANSCRIPT_DIVERGED' as const }
        }
        if (dispatch.phase === 'prepared') return { kind: 'ready' as const, dispatch: clone(dispatch) }
        if (dispatch.phase === 'terminal') return { kind: 'completed' as const, result: clone(dispatch.terminal!) }
        if (dispatch.phase === 'interrupted') {
          return { kind: 'interrupted' as const, code: dispatch.interruptionCode! }
        }
        if (dispatch.phase === 'tool-pending' || dispatch.phase === 'tool-recorded') {
          return { kind: 'interrupted' as const, code: 'TOOL_OUTCOME_UNCERTAIN' as const }
        }
        return { kind: 'interrupted' as const, code: 'PROVIDER_OUTCOME_UNCERTAIN' as const }
      })
    },
  }
}

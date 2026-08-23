// Agent Card revision registry (ADR-0069).
//
// Publishing a card creates an immutable, forward-only revision. Nothing here
// mutates an existing revision, and no capability is ever merged across scopes:
// a Project card shadows a Workspace card of the same name outright.
// Persistence, CLI and Telegram surfaces are deliberately not part of this file.

import { createHash } from 'node:crypto'

import type { ApprovalProof } from '../gateway/types.js'
import type { AgentCard } from '../orchestration/index.js'
import { validateAgentCardValue } from './agent-cards.js'

export type AgentCardScope = 'workspace' | 'project'
export type AgentCardBinding =
  | Readonly<{ scope: 'workspace' }>
  | Readonly<{ scope: 'project'; projectId: string }>
export type AgentCardStatus = 'active' | 'superseded' | 'archived'
export type AgentCardProvenance = 'published' | 'legacy-import'
export type AgentCardLifecycleOperation =
  | 'create' | 'publish' | 'rollback' | 'import-legacy' | 'archive'

export type AgentCardTarget = Readonly<{
  binding: AgentCardBinding
  name: string
}>

export type AgentCardLifecycleHead = Readonly<{
  revision: number
  status: AgentCardStatus
  hash: string
}>

export type AgentCardLifecycleEnvelope = Readonly<{
  operation: AgentCardLifecycleOperation
  target: AgentCardTarget
  expectedHead: AgentCardLifecycleHead | null
  sourceRevision: number | null
  result: Readonly<{
    revision: number
    status: 'active' | 'archived'
    hash: string
  }>
}>

export type AgentCardLifecyclePlanInput =
  | Readonly<{ operation: 'create' | 'publish' | 'import-legacy'; target: AgentCardTarget; card: AgentCard }>
  | Readonly<{ operation: 'rollback' | 'archive'; target: AgentCardTarget }>

export interface AgentCardCatalogEntry {
  readonly binding: AgentCardBinding
  readonly name: string
  readonly activeRevision: number | null
  readonly activeHashPrefix: string | null
  readonly latestRevision: number
  readonly latestHashPrefix: string
  readonly latestStatus: AgentCardStatus
  readonly revisionCount: number
}

export type AgentCardRegistryRefusal =
  | 'approval-mismatch'
  | 'approval-already-used'
  | 'invalid-card'
  | 'invalid-scope'
  | 'revision-not-found'
  | 'already-archived'
  | 'legacy-import-not-first'
  | 'history-exists'
  | 'history-empty'
  | 'not-active'
  | 'rollback-source-missing'
  | 'head-mismatch'

export class AgentCardRegistryError extends Error {
  constructor(readonly reason: AgentCardRegistryRefusal) {
    super(`agent card registry refused: ${reason}`)
    this.name = 'AgentCardRegistryError'
  }
}

export interface AgentCardRevision {
  readonly binding: AgentCardBinding
  readonly name: string
  readonly revision: number
  readonly hash: string
  readonly status: AgentCardStatus
  readonly provenance: AgentCardProvenance
  readonly publishedAt: string
  readonly card: AgentCard
}

/** Step-up approval bound to one exact lifecycle transition. */
export interface AgentCardEnvelopeApproval {
  envelope: AgentCardLifecycleEnvelope
  approvedBy: string
  proof: ApprovalProof
}

export interface AgentCardRegistry {
  catalog(binding: AgentCardBinding): readonly AgentCardCatalogEntry[]
  planLifecycle(input: AgentCardLifecyclePlanInput): AgentCardLifecycleEnvelope
  commitLifecycle(input: {
    envelope: AgentCardLifecycleEnvelope
    card?: AgentCard
    approval: AgentCardEnvelopeApproval
  }): AgentCardRevision
  /** Active revision for a run: a Project card fully shadows the Workspace one. */
  resolveActive(name: string, binding: AgentCardBinding): AgentCardRevision | null
  /** Exact revision, including archived ones — for auditing a finished run. */
  resolveExact(binding: AgentCardBinding, name: string, revision: number): AgentCardRevision | null
  history(binding: AgentCardBinding, name: string): AgentCardRevision[]
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Byte-stable hash of the full card content; identical cards always hash equal. */
export function canonicalAgentCardHash(card: AgentCard): string {
  const snapshot = validateAgentCardValue(card)
  return createHash('sha256').update(JSON.stringify(sortDeep(snapshot)), 'utf8').digest('hex')
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const APPROVAL_KEYS = new Set(['envelope', 'approvedBy', 'proof'])
const PROOF_KEYS = new Set(['cardId', 'actionId', 'actionHash', 'confirmedAt', 'stepUpVerified'])
const OPERATIONS = new Set<AgentCardLifecycleOperation>([
  'create', 'publish', 'rollback', 'import-legacy', 'archive',
])
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/

function exactInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  const canonical = new Date(parsed).toISOString()
  return value === canonical || value === canonical.replace('.000Z', 'Z')
}

function cardSnapshot(value: unknown): AgentCard | null {
  try {
    const snapshot = validateAgentCardValue(value)
    // `general` and builtin provenance are code-owned. A lifecycle publication
    // must never replace the bundled least-authority fallback.
    return snapshot.name === 'general' || snapshot.provenance === 'builtin' ? null : snapshot
  } catch {
    return null
  }
}

function bindingSnapshot(value: unknown): AgentCardBinding | null {
  try {
    if (typeof value !== 'object' || value === null ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const scope = descriptors['scope']
    if (!scope || !('value' in scope)) return null
    if (scope.value === 'workspace') {
      if (Object.keys(descriptors).length !== 1) return null
      return Object.freeze({ scope: 'workspace' })
    }
    const projectId = descriptors['projectId']
    if (scope.value !== 'project' || Object.keys(descriptors).length !== 2 ||
      !projectId || !('value' in projectId) || typeof projectId.value !== 'string' ||
      !PROJECT_ID.test(projectId.value)) return null
    return Object.freeze({ scope: 'project', projectId: projectId.value })
  } catch {
    return null
  }
}

function assertBinding(value: unknown): AgentCardBinding {
  const binding = bindingSnapshot(value)
  if (!binding) throw new AgentCardRegistryError('invalid-scope')
  return binding
}

function bindingKey(binding: AgentCardBinding): string {
  return binding.scope === 'workspace' ? 'workspace' : `project\u0000${binding.projectId}`
}

function exactOwnValues(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).length !== keys.size) return null
    const out: Record<string, unknown> = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!keys.has(key) || !('value' in descriptor)) return null
      out[key] = descriptor.value
    }
    return out
  } catch {
    return null
  }
}

const TARGET_KEYS = new Set(['binding', 'name'])
const HEAD_KEYS = new Set(['revision', 'status', 'hash'])
const RESULT_KEYS = new Set(['revision', 'status', 'hash'])
const ENVELOPE_KEYS = new Set(['operation', 'target', 'expectedHead', 'sourceRevision', 'result'])

function targetSnapshot(value: unknown): AgentCardTarget | null {
  const raw = exactOwnValues(value, TARGET_KEYS)
  const binding = raw ? bindingSnapshot(raw['binding']) : null
  if (!raw || !binding || typeof raw['name'] !== 'string' || !NAME.test(raw['name'])) return null
  return Object.freeze({ binding, name: raw['name'] })
}

function headSnapshot(value: unknown): AgentCardLifecycleHead | null {
  const raw = exactOwnValues(value, HEAD_KEYS)
  if (!raw || !Number.isSafeInteger(raw['revision']) || (raw['revision'] as number) < 1 ||
    !STATUSES.has(raw['status'] as AgentCardStatus) || typeof raw['hash'] !== 'string' ||
    !HASH.test(raw['hash'])) return null
  return Object.freeze({
    revision: raw['revision'] as number,
    status: raw['status'] as AgentCardStatus,
    hash: raw['hash'],
  })
}

function lifecycleEnvelopeSnapshot(value: unknown): AgentCardLifecycleEnvelope {
  const raw = exactOwnValues(value, ENVELOPE_KEYS)
  const target = raw ? targetSnapshot(raw['target']) : null
  const expectedHead = raw?.['expectedHead'] === null ? null : headSnapshot(raw?.['expectedHead'])
  const result = raw ? exactOwnValues(raw['result'], RESULT_KEYS) : null
  if (!raw || !target || !OPERATIONS.has(raw['operation'] as AgentCardLifecycleOperation) ||
    (raw['expectedHead'] !== null && expectedHead === null) ||
    (raw['sourceRevision'] !== null &&
      (!Number.isSafeInteger(raw['sourceRevision']) || (raw['sourceRevision'] as number) < 1)) ||
    !result || !Number.isSafeInteger(result['revision']) || (result['revision'] as number) < 1 ||
    (result['status'] !== 'active' && result['status'] !== 'archived') ||
    typeof result['hash'] !== 'string' || !HASH.test(result['hash'])) {
    throw new AgentCardRegistryError('approval-mismatch')
  }
  return Object.freeze({
    operation: raw['operation'] as AgentCardLifecycleOperation,
    target,
    expectedHead,
    sourceRevision: raw['sourceRevision'] as number | null,
    result: Object.freeze({
      revision: result['revision'] as number,
      status: result['status'] as 'active' | 'archived',
      hash: result['hash'],
    }),
  })
}

function envelopeTuple(envelope: AgentCardLifecycleEnvelope): readonly unknown[] {
  return [
    envelope.operation,
    bindingKey(envelope.target.binding),
    envelope.target.name,
    envelope.expectedHead === null ? null : [
      envelope.expectedHead.revision,
      envelope.expectedHead.status,
      envelope.expectedHead.hash,
    ],
    envelope.sourceRevision,
    envelope.result.revision,
    envelope.result.status,
    envelope.result.hash,
  ]
}

const PLAN_WITH_CARD_KEYS = new Set(['operation', 'target', 'card'])
const PLAN_NO_CARD_KEYS = new Set(['operation', 'target'])

function lifecyclePlanInputSnapshot(value: unknown): AgentCardLifecyclePlanInput {
  const withCard = exactOwnValues(value, PLAN_WITH_CARD_KEYS)
  const withoutCard = withCard === null ? exactOwnValues(value, PLAN_NO_CARD_KEYS) : null
  const raw = withCard ?? withoutCard
  const target = raw ? targetSnapshot(raw['target']) : null
  if (!raw || !target || !OPERATIONS.has(raw['operation'] as AgentCardLifecycleOperation)) {
    throw new AgentCardRegistryError('invalid-scope')
  }
  const operation = raw['operation'] as AgentCardLifecycleOperation
  if (operation === 'create' || operation === 'publish' || operation === 'import-legacy') {
    if (!withCard) throw new AgentCardRegistryError('invalid-card')
    const card = cardSnapshot(withCard['card'])
    if (!card || card.name !== target.name) throw new AgentCardRegistryError('invalid-card')
    return Object.freeze({ operation, target, card })
  }
  if (!withoutCard) throw new AgentCardRegistryError('approval-mismatch')
  return Object.freeze({ operation, target })
}

function revisionHead(revision: AgentCardRevision): AgentCardLifecycleHead {
  return Object.freeze({ revision: revision.revision, status: revision.status, hash: revision.hash })
}

function makeEnvelope(input: {
  operation: AgentCardLifecycleOperation
  target: AgentCardTarget
  expectedHead: AgentCardLifecycleHead | null
  sourceRevision: number | null
  revision: number
  status: 'active' | 'archived'
  hash: string
}): AgentCardLifecycleEnvelope {
  return Object.freeze({
    operation: input.operation,
    target: input.target,
    expectedHead: input.expectedHead,
    sourceRevision: input.sourceRevision,
    result: Object.freeze({ revision: input.revision, status: input.status, hash: input.hash }),
  })
}

function sameEnvelope(left: AgentCardLifecycleEnvelope, right: AgentCardLifecycleEnvelope): boolean {
  return JSON.stringify(envelopeTuple(left)) === JSON.stringify(envelopeTuple(right))
}

export function agentCardLifecycleAction(
  input: AgentCardLifecycleEnvelope,
): Readonly<{ actionId: string; actionHash: string }> {
  const envelope = lifecycleEnvelopeSnapshot(input)
  const actionId = `agent-card:${envelope.operation}:${envelope.target.name}:${envelope.result.revision}`
  const actionHash = createHash('sha256').update(JSON.stringify([
    'aisy.agent-card.lifecycle.v2', ...envelopeTuple(envelope),
  ])).digest('hex')
  return Object.freeze({ actionId, actionHash })
}

function proofSnapshot(value: unknown): ApprovalProof | null {
  try {
    if (typeof value !== 'object' || value === null ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).length !== PROOF_KEYS.size) return null
    const raw: Record<string, unknown> = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!PROOF_KEYS.has(key) || !('value' in descriptor)) return null
      raw[key] = descriptor.value
    }
    if (typeof raw['cardId'] !== 'string' || raw['cardId'].trim() === '' ||
      typeof raw['actionId'] !== 'string' || typeof raw['actionHash'] !== 'string' ||
      !exactInstant(raw['confirmedAt']) || raw['stepUpVerified'] !== true) return null
    return Object.freeze({
      cardId: raw['cardId'],
      actionId: raw['actionId'],
      actionHash: raw['actionHash'],
      confirmedAt: raw['confirmedAt'],
      stepUpVerified: true,
    })
  } catch {
    return null
  }
}

function envelopeApprovalKey(approval: AgentCardEnvelopeApproval): string {
  return [JSON.stringify(envelopeTuple(approval.envelope)), approval.approvedBy, approval.proof.cardId].join('\u0000')
}

function validateEnvelopeApproval(
  approval: unknown,
  expected: AgentCardLifecycleEnvelope,
): AgentCardEnvelopeApproval {
  const raw = exactOwnValues(approval, APPROVAL_KEYS)
  let envelope: AgentCardLifecycleEnvelope | null = null
  try { envelope = raw ? lifecycleEnvelopeSnapshot(raw['envelope']) : null } catch { envelope = null }
  const proof = raw ? proofSnapshot(raw['proof']) : null
  const expectedAction = agentCardLifecycleAction(expected)
  if (!raw || !envelope || JSON.stringify(envelopeTuple(envelope)) !== JSON.stringify(envelopeTuple(expected)) ||
    typeof raw['approvedBy'] !== 'string' || raw['approvedBy'].trim() === '' || !proof ||
    proof.actionId !== expectedAction.actionId || proof.actionHash !== expectedAction.actionHash) {
    throw new AgentCardRegistryError('approval-mismatch')
  }
  return Object.freeze({ envelope, approvedBy: raw['approvedBy'], proof })
}

/** Durable state adapter; the transport only moves bytes, validation stays here. */
export interface AgentCardRegistryPersistencePort {
  load(): unknown
  save(state: AgentCardRegistryStateV2): void
}

/** Legacy state lacked a Project identity and is accepted only for Workspace migration. */
export interface AgentCardRegistryStateV1 {
  schemaVersion: 1
  revisions: unknown[]
}

export interface AgentCardRegistryStateV2 {
  schemaVersion: 2
  revisions: AgentCardRevision[]
}

const STATUSES = new Set<AgentCardStatus>(['active', 'superseded', 'archived'])
const PROVENANCES = new Set<AgentCardProvenance>(['published', 'legacy-import'])
const REVISION_KEYS_V1 = new Set([
  'scope', 'name', 'revision', 'hash', 'status', 'provenance', 'publishedAt', 'card',
])
const REVISION_KEYS_V2 = new Set([
  'binding', 'name', 'revision', 'hash', 'status', 'provenance', 'publishedAt', 'card',
])

function ownRevisionValues(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(descriptors).length !== keys.size) return null
  const out: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key) || !('value' in descriptor)) return null
    out[key] = descriptor.value
  }
  return out
}

function revisionCandidateGroup(value: unknown, schemaVersion: 1 | 2): string | null {
  try {
    if (typeof value !== 'object' || value === null || Object.getOwnPropertySymbols(value).length > 0) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const nameDescriptor = descriptors['name']
    if (!nameDescriptor || !('value' in nameDescriptor) || typeof nameDescriptor.value !== 'string' ||
      !NAME.test(nameDescriptor.value)) return null
    const binding = schemaVersion === 1
      ? descriptors['scope'] && 'value' in descriptors['scope'] && descriptors['scope'].value === 'workspace'
        ? Object.freeze({ scope: 'workspace' as const })
        : null
      : descriptors['binding'] && 'value' in descriptors['binding']
        ? bindingSnapshot(descriptors['binding'].value)
        : null
    return binding ? `${bindingKey(binding)}\u0000${nameDescriptor.value}` : null
  } catch {
    return null
  }
}

/**
 * Fail-closed parse of durable state. A revision whose stored hash disagrees with
 * its own content is dropped: a hand-edited registry file must not silently become
 * capability authority.
 */
export function validateAgentCardRegistryState(raw: unknown): AgentCardRevision[] {
  if (typeof raw !== 'object' || raw === null || Object.getPrototypeOf(raw) !== Object.prototype ||
    Object.getOwnPropertySymbols(raw).length > 0) return []
  const root = Object.getOwnPropertyDescriptors(raw)
  if (Object.keys(root).length !== 2 || !('value' in (root['schemaVersion'] ?? {})) ||
    !('value' in (root['revisions'] ?? {}))) return []
  const schemaVersion = root['schemaVersion']?.value
  if (schemaVersion !== 1 && schemaVersion !== 2) return []
  const list = root['revisions']?.value
  if (!Array.isArray(list)) return []

  const accepted: AgentCardRevision[] = []
  const seen = new Set<string>()
  const malformedGroups = new Set<string>()
  for (const item of list) {
    const rawCandidateGroup = revisionCandidateGroup(item, schemaVersion)
    let value: Record<string, unknown> | null = null
    try {
      value = ownRevisionValues(item, schemaVersion === 1 ? REVISION_KEYS_V1 : REVISION_KEYS_V2)
    } catch { value = null }
    // V1 Project entries carry no projectId. They cannot be attributed safely
    // and are deliberately dropped instead of inheriting the selected Project.
    const binding = value === null
      ? null
      : schemaVersion === 1
        ? value['scope'] === 'workspace' ? Object.freeze({ scope: 'workspace' as const }) : null
        : bindingSnapshot(value['binding'])
    const candidateGroup = binding && typeof value?.['name'] === 'string' && NAME.test(value['name'])
      ? `${bindingKey(binding)}\u0000${value['name']}`
      : rawCandidateGroup
    if (!value || !binding ||
      !STATUSES.has(value['status'] as AgentCardStatus) ||
      !PROVENANCES.has(value['provenance'] as AgentCardProvenance) ||
      typeof value['name'] !== 'string' || !NAME.test(value['name']) ||
      !Number.isSafeInteger(value['revision']) || (value['revision'] as number) < 1 ||
      !exactInstant(value['publishedAt'])) {
      if (candidateGroup) malformedGroups.add(candidateGroup)
      continue
    }
    const card = cardSnapshot(value['card'])
    if (!card || card.name !== value['name'] || typeof value['hash'] !== 'string' ||
      canonicalAgentCardHash(card) !== value['hash']) {
      if (candidateGroup) malformedGroups.add(candidateGroup)
      continue
    }
    const identity = `${bindingKey(binding)} ${value['name']} ${value['revision']}`
    if (seen.has(identity)) {
      if (candidateGroup) malformedGroups.add(candidateGroup)
      continue
    }
    seen.add(identity)
    accepted.push(Object.freeze({
      binding,
      name: value['name'],
      revision: value['revision'] as number,
      hash: value['hash'],
      status: value['status'] as AgentCardStatus,
      provenance: value['provenance'] as AgentCardProvenance,
      publishedAt: value['publishedAt'],
      card,
    }))
  }
  const groups = new Map<string, AgentCardRevision[]>()
  for (const item of accepted) {
    const identity = `${bindingKey(item.binding)}\u0000${item.name}`
    const group = groups.get(identity) ?? []
    group.push(item)
    groups.set(identity, group)
  }
  const valid: AgentCardRevision[] = []
  for (const [identity, group] of groups) {
    if (malformedGroups.has(identity)) continue
    group.sort((a, b) => a.revision - b.revision)
    const latest = group[group.length - 1]
    const contiguous = group.every((item, index) => item.revision === index + 1)
    const earlierInactive = group.slice(0, -1).every(item => item.status !== 'active')
    const provenanceValid = group.every(item => item.provenance !== 'legacy-import' || item.revision === 1)
    if (!latest || !contiguous || !earlierInactive || latest.status === 'superseded' || !provenanceValid) continue
    valid.push(...group)
  }
  return valid
}

export function makeAgentCardRegistry(input?: {
  revisions?: readonly AgentCardRevision[]
  persistence?: AgentCardRegistryPersistencePort
  nowIso?: () => string
}): AgentCardRegistry {
  const nowIso = input?.nowIso ?? (() => new Date().toISOString())
  const restored = input?.persistence
    ? validateAgentCardRegistryState((() => {
      try { return input.persistence?.load() } catch { return undefined }
    })())
    : []
  let revisions: AgentCardRevision[] = validateAgentCardRegistryState({
    schemaVersion: 2,
    revisions: [...(input?.revisions ?? []), ...restored],
  })
  const usedApprovals = new Set<string>()
  const persist = (next: readonly AgentCardRevision[]): void => {
    input?.persistence?.save({ schemaVersion: 2, revisions: [...next] })
  }

  const key = (binding: AgentCardBinding, name: string): string => `${bindingKey(binding)}\u0000${name}`
  const forCard = (binding: AgentCardBinding, name: string): AgentCardRevision[] =>
    revisions.filter(item => key(item.binding, item.name) === key(binding, name))
      .sort((a, b) => a.revision - b.revision)

  const nextRevision = (binding: AgentCardBinding, name: string): number => {
    const existing = forCard(binding, name)
    return (existing[existing.length - 1]?.revision ?? 0) + 1
  }

  const assertUnusedEnvelope = (approval: AgentCardEnvelopeApproval): string => {
    const identity = `envelope\u0000${envelopeApprovalKey(approval)}`
    if (usedApprovals.has(identity)) throw new AgentCardRegistryError('approval-already-used')
    return identity
  }

  const lastWhere = <T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item !== undefined && predicate(item)) return item
    }
    return undefined
  }

  const planLifecycle = (rawInput: AgentCardLifecyclePlanInput): AgentCardLifecycleEnvelope => {
    const planned = lifecyclePlanInputSnapshot(rawInput)
    const history = forCard(planned.target.binding, planned.target.name)
    const head = history[history.length - 1] ?? null
    const expectedHead = head === null ? null : revisionHead(head)

    switch (planned.operation) {
      case 'create':
      case 'import-legacy':
        if (head !== null) throw new AgentCardRegistryError('history-exists')
        return makeEnvelope({
          operation: planned.operation,
          target: planned.target,
          expectedHead: null,
          sourceRevision: null,
          revision: 1,
          status: 'active',
          hash: canonicalAgentCardHash(planned.card),
        })
      case 'publish':
        if (head === null) throw new AgentCardRegistryError('history-empty')
        return makeEnvelope({
          operation: 'publish',
          target: planned.target,
          expectedHead,
          sourceRevision: null,
          revision: head.revision + 1,
          status: 'active',
          hash: canonicalAgentCardHash(planned.card),
        })
      case 'archive': {
        const active = lastWhere(history, item => item.status === 'active')
        if (active === undefined || active !== head) throw new AgentCardRegistryError('not-active')
        return makeEnvelope({
          operation: 'archive',
          target: planned.target,
          expectedHead,
          sourceRevision: null,
          revision: active.revision,
          status: 'archived',
          hash: active.hash,
        })
      }
      case 'rollback': {
        if (head === null) throw new AgentCardRegistryError('history-empty')
        const source = head.status === 'active'
          ? lastWhere(history, item => item.revision < head.revision)
          : head
        if (source === undefined) throw new AgentCardRegistryError('rollback-source-missing')
        return makeEnvelope({
          operation: 'rollback',
          target: planned.target,
          expectedHead,
          sourceRevision: source.revision,
          revision: head.revision + 1,
          status: 'active',
          hash: source.hash,
        })
      }
    }
  }

  const exactCurrentHead = (target: AgentCardTarget): AgentCardLifecycleHead | null => {
    const history = forCard(target.binding, target.name)
    const head = history[history.length - 1]
    return head ? revisionHead(head) : null
  }

  const commitLifecycle: AgentCardRegistry['commitLifecycle'] = ({ envelope: rawEnvelope, card, approval }) => {
    const envelope = lifecycleEnvelopeSnapshot(rawEnvelope)
    const checkedApproval = validateEnvelopeApproval(approval, envelope)
    const currentHead = exactCurrentHead(envelope.target)
    const currentHeadJson = currentHead === null ? 'null' : JSON.stringify(currentHead)
    const expectedHeadJson = envelope.expectedHead === null ? 'null' : JSON.stringify(envelope.expectedHead)
    if (currentHeadJson !== expectedHeadJson) throw new AgentCardRegistryError('head-mismatch')

    let planInput: AgentCardLifecyclePlanInput
    if (envelope.operation === 'create' || envelope.operation === 'publish' || envelope.operation === 'import-legacy') {
      if (card === undefined) throw new AgentCardRegistryError('invalid-card')
      planInput = { operation: envelope.operation, target: envelope.target, card }
    } else {
      planInput = { operation: envelope.operation, target: envelope.target }
    }
    const recomputed = planLifecycle(planInput)
    if (!sameEnvelope(envelope, recomputed)) throw new AgentCardRegistryError('approval-mismatch')
    const approvalIdentity = assertUnusedEnvelope(checkedApproval)

    let result: AgentCardRevision
    let next: AgentCardRevision[]
    if (envelope.operation === 'archive') {
      const target = revisions.find(item =>
        key(item.binding, item.name) === key(envelope.target.binding, envelope.target.name) &&
        item.revision === envelope.result.revision)
      if (!target) throw new AgentCardRegistryError('head-mismatch')
      result = Object.freeze({ ...target, status: 'archived' as const })
      next = revisions.map(item => item === target ? result : item)
    } else {
      const publishedAt = nowIso()
      if (!exactInstant(publishedAt)) throw new AgentCardRegistryError('invalid-card')
      const sourceCard = envelope.operation === 'rollback'
        ? forCard(envelope.target.binding, envelope.target.name)
          .find(item => item.revision === envelope.sourceRevision)?.card
        : card
      const snapshot = cardSnapshot(sourceCard)
      if (!snapshot || snapshot.name !== envelope.target.name || canonicalAgentCardHash(snapshot) !== envelope.result.hash) {
        throw new AgentCardRegistryError('approval-mismatch')
      }
      result = Object.freeze({
        binding: envelope.target.binding,
        name: envelope.target.name,
        revision: envelope.result.revision,
        hash: envelope.result.hash,
        status: 'active' as const,
        provenance: envelope.operation === 'import-legacy' ? 'legacy-import' as const : 'published' as const,
        publishedAt,
        card: snapshot,
      })
      next = [
        ...revisions.map(item =>
          key(item.binding, item.name) === key(envelope.target.binding, envelope.target.name) &&
          item.status === 'active'
            ? Object.freeze({ ...item, status: 'superseded' as const })
            : item),
        result,
      ]
    }
    persist(next)
    revisions = next
    usedApprovals.add(approvalIdentity)
    return result
  }

  return {
    catalog(rawBinding) {
      const binding = assertBinding(rawBinding)
      const names = [...new Set(revisions
        .filter(item => bindingKey(item.binding) === bindingKey(binding))
        .map(item => item.name))].sort()
      return Object.freeze(names.map(name => {
        const history = forCard(binding, name)
        const latest = history[history.length - 1]
        if (!latest) throw new AgentCardRegistryError('revision-not-found')
        const active = lastWhere(history, item => item.status === 'active')
        return Object.freeze({
          binding,
          name,
          activeRevision: active?.revision ?? null,
          activeHashPrefix: active?.hash.slice(0, 12) ?? null,
          latestRevision: latest.revision,
          latestHashPrefix: latest.hash.slice(0, 12),
          latestStatus: latest.status,
          revisionCount: history.length,
        })
      }))
    },

    planLifecycle,

    commitLifecycle,

    resolveActive(name, rawBinding) {
      const binding = assertBinding(rawBinding)
      const active = (target: AgentCardBinding): AgentCardRevision | null => {
        const candidates = forCard(target, name).filter(item => item.status === 'active')
        return candidates[candidates.length - 1] ?? null
      }
      // No merge: a Project card shadows the Workspace one outright.
      if (binding.scope === 'project') {
        return forCard(binding, name).length > 0 ? active(binding) : active({ scope: 'workspace' })
      }
      return active(binding)
    },

    resolveExact(rawBinding, name, revision) {
      const binding = assertBinding(rawBinding)
      return forCard(binding, name).find(item => item.revision === revision) ?? null
    },

    history(rawBinding, name) {
      const binding = assertBinding(rawBinding)
      return forCard(binding, name)
    },

  }
}

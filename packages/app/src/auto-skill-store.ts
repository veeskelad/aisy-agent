import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

import {
  parseAutoSkillManifest,
  parseSkillRecipeDraft,
  parseVerifiedWorkflowEvidence,
  renderAutoSkillDocument,
} from '@aisy/core'
import type {
  AutoSkillManifestV1,
  SkillRecipeDraftV1,
  VerifiedWorkflowEvidenceV1,
} from '@aisy/core'

const HASH = /^[a-f0-9]{64}$/u
const SAFE_COMMIT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const ROLLBACK_BARRIER = 'rollback-barrier-v1.json'
const STORE_EPOCH = 'store-epoch-v1'
const STORE_EPOCH_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MUTATION_INFLIGHT_PREFIX = '.mutation-inflight-'

export type AutoSkillJobPhase =
  | 'queued'
  | 'generated'
  | 'validated'
  | 'shadow_verified'
  | 'prepared'
  | 'active'
  | 'quarantined'
  | 'forgotten'

export type AutoSkillRevisionPhase =
  | 'prepared'
  | 'active'
  | 'demoted'
  | 'forget_claimed'
  | 'purging'
  | 'tombstoned'

export type AutoSkillPermanentFailure =
  | 'descriptor_missing'
  | 'placeholder_missing'
  | 'postcondition_mismatch'
  | 'required_step_omitted'
  | 'scope_mismatch'

export interface AutoSkillJobRecordV2 {
  readonly jobId: string
  readonly scopeKey: string
  readonly skillIdentity: string
  readonly workflowFingerprint: string
  readonly evidenceIds: readonly [string, string]
  readonly phase: AutoSkillJobPhase
  readonly baseRevisionHash: string | null
  readonly draft?: SkillRecipeDraftV1
  readonly revisionHash?: string
  readonly quarantineReason?: string
}

export interface AutoSkillRevisionRecordV2 {
  readonly revisionHash: string
  readonly scopeKey: string
  readonly skillIdentity: string
  readonly jobId: string
  readonly phase: AutoSkillRevisionPhase
  readonly previousHash: string | null
  readonly sourceSessionIds: readonly [string, string]
  readonly sourceProjectId: string
  readonly failure?: AutoSkillPermanentFailure
}

export interface AutoSkillActivationView {
  readonly manifest: AutoSkillManifestV1
  readonly renderedSkill: string
}

export interface AutoSkillDoctorReport {
  readonly schemaVersion: 2
  readonly evidence: number
  readonly pendingReply: number
  readonly queued: number
  readonly active: number
  readonly quarantined: number
  readonly forgetClaimed: number
  readonly ambiguousNotifications: number
}

export interface AutoSkillReadOnlyDoctorFinding extends AutoSkillDoctorReport {
  readonly state: 'disabled' | 'ready' | 'degraded' | 'corrupt'
  readonly rollbackBarrier: boolean
}

interface EvidenceRecord {
  value: VerifiedWorkflowEvidenceV1
  status: 'pending_reply' | 'live' | 'forget_claimed'
}

interface PointerRecord {
  pointerKey: string
  scopeKey: string
  skillIdentity: string
  activeHash: string
  previousHash: string | null
}

interface NotificationRecord {
  id: string
  revisionHash: string
  title: string
  status: 'pending' | 'claimed' | 'sent' | 'ambiguous'
}

interface ForgetClaimRecord {
  claimId: string
  sourceKind: 'session' | 'project'
  sourceIdHash: string
  sourceId?: string
  evidenceHashes: string[]
  revisionHashes: string[]
  phase: 'forget_claimed' | 'purging' | 'tombstoned'
}

interface RollbackCertificateRecord {
  certificateId: string
  stateHash: string
  targetCommit: string
}

interface StoreStateV2 {
  schemaVersion: 2
  evidence: EvidenceRecord[]
  jobs: AutoSkillJobRecordV2[]
  revisions: AutoSkillRevisionRecordV2[]
  pointers: PointerRecord[]
  notifications: NotificationRecord[]
  forgetClaims: ForgetClaimRecord[]
  rollbackCertificates: RollbackCertificateRecord[]
}

export interface NodeAutoSkillStoreV2 {
  stage(evidence: VerifiedWorkflowEvidenceV1): { kind: 'duplicate' | 'staged' }
  confirmReply(input: { evidenceId: string; sessionId: string; turnId: string }):
    | { kind: 'duplicate' | 'counted' }
    | { kind: 'queued'; jobId: string }
  nextWork(): AutoSkillJobRecordV2 | null
  evidenceFor(jobId: string): readonly [VerifiedWorkflowEvidenceV1, VerifiedWorkflowEvidenceV1]
  advanceJob(input: {
    jobId: string
    expected: AutoSkillJobPhase
    next: AutoSkillJobPhase
    draft?: SkillRecipeDraftV1
  }): AutoSkillJobRecordV2
  quarantine(jobId: string, reason: string): void
  prepare(input: {
    jobId: string
    manifest: AutoSkillManifestV1
    renderedSkill: string
  }): AutoSkillRevisionRecordV2
  activate(jobId: string, revisionHash: string): AutoSkillRevisionRecordV2
  active(scopeKey: string, skillIdentity: string): AutoSkillActivationView | null
  activeForScope(scopeKey: string): readonly AutoSkillActivationView[]
  permanentFailure(revisionHash: string, failure: AutoSkillPermanentFailure): void
  claimBySource(input: { sessionId?: string; projectId?: string }): { claimId: string; affected: number }
  purgeClaim(claimId: string): void
  recoverForgetClaims(sourceArchived?: (source: Readonly<{
    kind: 'session' | 'project'
    id: string
  }>) => boolean): number
  issueRollbackCertificate(targetCommit: string): Readonly<RollbackCertificateRecord> | null
  verifyRollbackCertificate(certificateId: string, targetCommit: string): boolean
  claimNotification(): Readonly<NotificationRecord> | null
  completeNotification(id: string, outcome: 'sent' | 'ambiguous'): void
  doctor(): Readonly<AutoSkillDoctorReport>
}

export interface NodeAutoSkillRollbackAuthorization {
  readonly certificateId: string
  readonly targetCommit: string
}

export type NodeAutoSkillRollbackBarrierStatus = 'absent' | 'certified' | 'unsafe'

type NodeAutoSkillRollbackBarrier = Readonly<
  | { phase: 'preparing'; targetCommit: string }
  | {
    phase: 'certified'
    certificateId: string
    targetCommit: string
  }
>

function hash(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\n${value}`).digest('hex')
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function pointerKey(scopeKey: string, skillIdentity: string): string {
  return hash('aisy-auto-skill-pointer/v1', JSON.stringify([scopeKey, skillIdentity]))
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function onlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
}

const JOB_PHASES = new Set<AutoSkillJobPhase>([
  'queued', 'generated', 'validated', 'shadow_verified', 'prepared',
  'active', 'quarantined', 'forgotten',
])
const REVISION_PHASES = new Set<AutoSkillRevisionPhase>([
  'prepared', 'active', 'demoted', 'forget_claimed', 'purging', 'tombstoned',
])
const PERMANENT_FAILURES = new Set<AutoSkillPermanentFailure>([
  'descriptor_missing', 'placeholder_missing', 'postcondition_mismatch',
  'required_step_omitted', 'scope_mismatch',
])

function validState(value: unknown): value is StoreStateV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  const keys = Object.keys(raw).sort()
  const expected = [
    'evidence', 'forgetClaims', 'jobs', 'notifications', 'pointers',
    'revisions', 'rollbackCertificates', 'schemaVersion',
  ].sort()
  if (raw['schemaVersion'] !== 2 || JSON.stringify(keys) !== JSON.stringify(expected) ||
    !expected.filter(key => key !== 'schemaVersion').every(key => Array.isArray(raw[key]))) {
    return false
  }
  const candidate = raw as unknown as StoreStateV2
  if (!candidate.evidence.every(item => {
    const rawItem = record(item)
    return rawItem !== null && onlyKeys(rawItem, ['value', 'status']) &&
      (rawItem['status'] === 'pending_reply' || rawItem['status'] === 'live' ||
        rawItem['status'] === 'forget_claimed') &&
      parseVerifiedWorkflowEvidence(rawItem['value']) !== null
  })) return false
  if (!candidate.jobs.every(item => {
    const rawItem = record(item)
    if (rawItem === null || !onlyKeys(rawItem, [
      'jobId', 'scopeKey', 'skillIdentity', 'workflowFingerprint', 'evidenceIds',
      'phase', 'baseRevisionHash',
    ], ['draft', 'revisionHash', 'quarantineReason']) ||
      typeof rawItem['jobId'] !== 'string' || !HASH.test(rawItem['jobId']) ||
      typeof rawItem['scopeKey'] !== 'string' || !HASH.test(rawItem['scopeKey']) ||
      typeof rawItem['skillIdentity'] !== 'string' || !HASH.test(rawItem['skillIdentity']) ||
      typeof rawItem['workflowFingerprint'] !== 'string' ||
      !HASH.test(rawItem['workflowFingerprint']) ||
      typeof rawItem['phase'] !== 'string' ||
      !JOB_PHASES.has(rawItem['phase'] as AutoSkillJobPhase) ||
      (rawItem['baseRevisionHash'] !== null && (typeof rawItem['baseRevisionHash'] !== 'string' ||
        !HASH.test(rawItem['baseRevisionHash']))) || !Array.isArray(rawItem['evidenceIds']) ||
      rawItem['evidenceIds'].length !== 2 || rawItem['evidenceIds'].some(id =>
        typeof id !== 'string' || !HASH.test(id))) return false
    if (rawItem['draft'] !== undefined && parseSkillRecipeDraft(rawItem['draft']) === null) return false
    if (rawItem['revisionHash'] !== undefined && (typeof rawItem['revisionHash'] !== 'string' ||
      !HASH.test(rawItem['revisionHash']))) return false
    return rawItem['quarantineReason'] === undefined ||
      (typeof rawItem['quarantineReason'] === 'string' && rawItem['quarantineReason'].length <= 128)
  })) return false
  if (!candidate.revisions.every(item => {
    const rawItem = record(item)
    return rawItem !== null && onlyKeys(rawItem, [
      'revisionHash', 'scopeKey', 'skillIdentity', 'jobId', 'phase', 'previousHash',
      'sourceSessionIds', 'sourceProjectId',
    ], ['failure']) && typeof rawItem['revisionHash'] === 'string' &&
      HASH.test(rawItem['revisionHash']) && typeof rawItem['scopeKey'] === 'string' &&
      HASH.test(rawItem['scopeKey']) && typeof rawItem['skillIdentity'] === 'string' &&
      HASH.test(rawItem['skillIdentity']) && typeof rawItem['jobId'] === 'string' &&
      HASH.test(rawItem['jobId']) && typeof rawItem['phase'] === 'string' &&
      REVISION_PHASES.has(rawItem['phase'] as AutoSkillRevisionPhase) &&
      (rawItem['previousHash'] === null || (typeof rawItem['previousHash'] === 'string' &&
        HASH.test(rawItem['previousHash']))) && Array.isArray(rawItem['sourceSessionIds']) &&
      rawItem['sourceSessionIds'].length === 2 && rawItem['sourceSessionIds'].every(id =>
        typeof id === 'string' && id.length > 0 && id.length <= 512) &&
      typeof rawItem['sourceProjectId'] === 'string' && rawItem['sourceProjectId'].length > 0 &&
      (rawItem['failure'] === undefined ||
        PERMANENT_FAILURES.has(rawItem['failure'] as AutoSkillPermanentFailure))
  })) return false
  if (!candidate.pointers.every(item => {
    const rawItem = record(item)
    return rawItem !== null && onlyKeys(rawItem, [
      'pointerKey', 'scopeKey', 'skillIdentity', 'activeHash', 'previousHash',
    ]) && typeof rawItem['pointerKey'] === 'string' && typeof rawItem['scopeKey'] === 'string' &&
      typeof rawItem['skillIdentity'] === 'string' && typeof rawItem['activeHash'] === 'string' &&
      rawItem['pointerKey'] === pointerKey(rawItem['scopeKey'], rawItem['skillIdentity']) &&
      HASH.test(rawItem['scopeKey']) && HASH.test(rawItem['skillIdentity']) &&
      HASH.test(rawItem['activeHash']) && (rawItem['previousHash'] === null ||
        (typeof rawItem['previousHash'] === 'string' && HASH.test(rawItem['previousHash'])))
  })) return false
  if (!candidate.notifications.every(item => {
    const rawItem = record(item)
    return rawItem !== null && onlyKeys(rawItem, [
      'id', 'revisionHash', 'title', 'status',
    ]) && typeof rawItem['id'] === 'string' && HASH.test(rawItem['id']) &&
      typeof rawItem['revisionHash'] === 'string' && HASH.test(rawItem['revisionHash']) &&
      typeof rawItem['title'] === 'string' && rawItem['title'].length > 0 &&
      rawItem['title'].length <= 200 && ['pending', 'claimed', 'sent', 'ambiguous']
        .includes(String(rawItem['status']))
  })) return false
  if (!candidate.forgetClaims.every(item => {
    const rawItem = record(item)
    return rawItem !== null && onlyKeys(rawItem, [
      'claimId', 'sourceKind', 'sourceIdHash', 'evidenceHashes', 'revisionHashes', 'phase',
    ], ['sourceId']) && typeof rawItem['claimId'] === 'string' && HASH.test(rawItem['claimId']) &&
      (rawItem['sourceKind'] === 'session' || rawItem['sourceKind'] === 'project') &&
      typeof rawItem['sourceIdHash'] === 'string' && HASH.test(rawItem['sourceIdHash']) &&
      (rawItem['phase'] === 'tombstoned'
        ? rawItem['sourceId'] === undefined
        : typeof rawItem['sourceId'] === 'string' && rawItem['sourceId'].length > 0) &&
      Array.isArray(rawItem['evidenceHashes']) && rawItem['evidenceHashes'].every(id =>
        typeof id === 'string' && HASH.test(id)) &&
      Array.isArray(rawItem['revisionHashes']) && rawItem['revisionHashes'].every(id =>
        typeof id === 'string' && HASH.test(id)) &&
      ['forget_claimed', 'purging', 'tombstoned'].includes(String(rawItem['phase']))
  })) return false
  if (!candidate.rollbackCertificates.every(item => {
    const rawItem = record(item)
    return rawItem !== null && onlyKeys(rawItem, [
      'certificateId', 'stateHash', 'targetCommit',
    ]) && typeof rawItem['certificateId'] === 'string' && HASH.test(rawItem['certificateId']) &&
      typeof rawItem['stateHash'] === 'string' && HASH.test(rawItem['stateHash']) &&
      typeof rawItem['targetCommit'] === 'string' && SAFE_COMMIT.test(rawItem['targetCommit'])
  })) return false
  const evidenceIds = new Set(candidate.evidence.map(item => item.value.evidenceId))
  const jobIds = new Set(candidate.jobs.map(item => item.jobId))
  if (evidenceIds.size !== candidate.evidence.length || jobIds.size !== candidate.jobs.length ||
    candidate.jobs.some(item => item.phase !== 'forgotten' &&
      item.evidenceIds.some(id => !evidenceIds.has(id))) ||
    candidate.revisions.some(item => !jobIds.has(item.jobId))) return false
  const revisionIds = new Set(candidate.revisions.map(item => item.revisionHash))
  return revisionIds.size === candidate.revisions.length && candidate.pointers.every(item =>
    revisionIds.has(item.activeHash) && (item.previousHash === null || revisionIds.has(item.previousHash))) &&
    candidate.notifications.every(item => revisionIds.has(item.revisionHash))
}

function cloneState(state: StoreStateV2): StoreStateV2 {
  return structuredClone(state)
}

function rollbackStateHash(state: StoreStateV2): string {
  return hash('aisy-auto-skill-state/v2', JSON.stringify({
    ...state,
    rollbackCertificates: [],
  }))
}

function stateHasRollbackCertificate(
  state: StoreStateV2,
  certificateId: string,
  targetCommit: string,
): boolean {
  if (!HASH.test(certificateId) || !SAFE_COMMIT.test(targetCommit)) return false
  const dependencies = state.evidence.length + state.jobs.filter(item =>
    item.phase !== 'forgotten').length + state.revisions.filter(item =>
    item.phase !== 'tombstoned').length + state.pointers.length
  if (dependencies !== 0 || state.forgetClaims.some(item => item.phase !== 'tombstoned')) {
    return false
  }
  const stateHash = rollbackStateHash(state)
  return state.rollbackCertificates.some(item => item.certificateId === certificateId &&
    item.targetCommit === targetCommit && item.stateHash === stateHash)
}

type MutationMarker = Readonly<
  | { schemaVersion: 1; ownerPid: number; kind: 'state' }
  | { schemaVersion: 1; ownerPid: number; kind: 'artifact'; revisionHash: string }
  | { schemaVersion: 2; ownerPid: number; kind: 'state'; temporaryName: string }
  | {
    schemaVersion: 2
    ownerPid: number
    kind: 'artifact'
    revisionHash: string
    temporaryName: string
  }
>

function parseMutationMarker(
  path: string,
  ownerPid: number,
  markerId: string,
): MutationMarker | null {
  const raw = readFileSync(path, 'utf8')
  // Empty markers were emitted by the first v2 implementation. They carry no
  // artifact authority but remain a valid conservative state-mutation fence.
  if (raw === '') return { schemaVersion: 1, ownerPid, kind: 'state' }
  if (Buffer.byteLength(raw, 'utf8') > 512 || !raw.endsWith('\n')) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  const value = record(parsed)
  if (value === null || (value['schemaVersion'] !== 1 && value['schemaVersion'] !== 2) ||
    value['ownerPid'] !== ownerPid ||
    (value['kind'] !== 'state' && value['kind'] !== 'artifact')) return null
  if (value['schemaVersion'] === 2) {
    const expectedTemporaryName = value['kind'] === 'state'
      ? `.state-${ownerPid}-${markerId}.tmp`
      : `.revision-${markerId}.tmp`
    if (value['temporaryName'] !== expectedTemporaryName) return null
    if (value['kind'] === 'state') {
      return onlyKeys(value, ['schemaVersion', 'ownerPid', 'kind', 'temporaryName'])
        ? {
            schemaVersion: 2,
            ownerPid,
            kind: 'state',
            temporaryName: expectedTemporaryName,
          }
        : null
    }
    return onlyKeys(value, [
      'schemaVersion', 'ownerPid', 'kind', 'revisionHash', 'temporaryName',
    ]) && typeof value['revisionHash'] === 'string' && HASH.test(value['revisionHash'])
      ? {
          schemaVersion: 2,
          ownerPid,
          kind: 'artifact',
          revisionHash: value['revisionHash'],
          temporaryName: expectedTemporaryName,
        }
      : null
  }
  if (value['kind'] === 'state') {
    return onlyKeys(value, ['schemaVersion', 'ownerPid', 'kind'])
      ? { schemaVersion: 1, ownerPid, kind: 'state' }
      : null
  }
  return onlyKeys(value, ['schemaVersion', 'ownerPid', 'kind', 'revisionHash']) &&
    typeof value['revisionHash'] === 'string' && HASH.test(value['revisionHash'])
    ? { schemaVersion: 1, ownerPid, kind: 'artifact', revisionHash: value['revisionHash'] }
    : null
}

function reconcileDeadTemporary(root: string, marker: MutationMarker): boolean {
  if (marker.schemaVersion !== 2) return false
  const parent = marker.kind === 'state' ? root : join(root, 'revisions')
  const path = join(parent, marker.temporaryName)
  if (!existsSync(path)) return false
  const info = lstatSync(path)
  if (info.isSymbolicLink() || (marker.kind === 'state' ? !info.isFile() : !info.isDirectory())) {
    throw new Error('AUTO_SKILL_MUTATION_MARKER_INVALID')
  }
  if (marker.kind === 'artifact') rmSync(path, { recursive: true })
  else rmSync(path)
  syncPath(parent)
  return true
}

function orphanTemporaryExists(root: string): boolean {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
  const stateTemporary = new RegExp(`^\\.state-[1-9][0-9]*-${uuid}\\.tmp$`, 'u')
  const artifactTemporary = new RegExp(`^\\.revision-${uuid}\\.tmp$`, 'u')
  return readdirSync(root).some(name => stateTemporary.test(name)) ||
    readdirSync(join(root, 'revisions')).some(name => artifactTemporary.test(name))
}

function inspectMutationResidue(root: string): 'none' | 'inflight' | 'corrupt' {
  const markerTemporaryNames = new Map<string, 'state' | 'artifact'>()
  let markerFound = false
  for (const name of readdirSync(root)) {
    if (!name.startsWith(MUTATION_INFLIGHT_PREFIX)) continue
    markerFound = true
    const path = join(root, name)
    const info = lstatSync(path)
    const match = /^\.mutation-inflight-([1-9][0-9]*)-([0-9a-f-]{36})$/.exec(name)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      info.size > 512 || match === null || !STORE_EPOCH_VALUE.test(match[2]!)) return 'corrupt'
    const ownerPid = Number(match[1])
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return 'corrupt'
    const marker = parseMutationMarker(path, ownerPid, match[2]!)
    if (marker === null) return 'corrupt'
    if (marker.schemaVersion === 2) markerTemporaryNames.set(marker.temporaryName, marker.kind)
  }
  const statePrefix = '.state-'
  for (const name of readdirSync(root)) {
    if (!name.startsWith(statePrefix) || !name.endsWith('.tmp')) continue
    if (markerTemporaryNames.get(name) !== 'state') return 'corrupt'
    const info = lstatSync(join(root, name))
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return 'corrupt'
  }
  const revisionsRoot = join(root, 'revisions')
  if (!existsSync(revisionsRoot)) return 'corrupt'
  const revisionsInfo = lstatSync(revisionsRoot)
  if (!revisionsInfo.isDirectory() || revisionsInfo.isSymbolicLink() ||
    (revisionsInfo.mode & 0o077) !== 0) return 'corrupt'
  for (const name of readdirSync(revisionsRoot)) {
    if (!name.startsWith('.revision-') || !name.endsWith('.tmp')) continue
    if (markerTemporaryNames.get(name) !== 'artifact') return 'corrupt'
    const info = lstatSync(join(revisionsRoot, name))
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return 'corrupt'
  }
  return markerFound ? 'inflight' : 'none'
}

function reconcileDeadArtifact(root: string, revisionHash: string): boolean {
  const statePath = join(root, 'state-v2.json')
  let referenced = false
  if (existsSync(statePath)) {
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(statePath, 'utf8')) } catch {
      throw new Error('AUTO_SKILL_STORE_CORRUPT')
    }
    if (!validState(parsed)) throw new Error('AUTO_SKILL_STORE_CORRUPT')
    referenced = parsed.revisions.some(revision => revision.revisionHash === revisionHash)
  }
  if (referenced) return false
  const directory = join(root, 'revisions', revisionHash)
  if (!existsSync(directory)) return false
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('AUTO_SKILL_ARTIFACT_CONFLICT')
  }
  rmSync(directory, { recursive: true })
  syncPath(join(root, 'revisions'))
  return true
}

function mutationInFlight(root: string): boolean {
  const inventory: Array<Readonly<{
    path: string
    marker: MutationMarker
    owner: 'live' | 'dead'
  }>> = []
  let removed = false
  for (const name of readdirSync(root)) {
    if (!name.startsWith(MUTATION_INFLIGHT_PREFIX)) continue
    const path = join(root, name)
    const info = lstatSync(path)
    const match = /^\.mutation-inflight-([1-9][0-9]*)-([0-9a-f-]{36})$/.exec(name)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      info.size > 512 || match === null) {
      throw new Error('AUTO_SKILL_MUTATION_MARKER_INVALID')
    }
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error('AUTO_SKILL_MUTATION_MARKER_INVALID')
    }
    const markerId = match[2]!
    if (!STORE_EPOCH_VALUE.test(markerId)) {
      throw new Error('AUTO_SKILL_MUTATION_MARKER_INVALID')
    }
    const marker = parseMutationMarker(path, pid, markerId)
    if (marker === null) throw new Error('AUTO_SKILL_MUTATION_MARKER_INVALID')
    try {
      process.kill(pid, 0)
      inventory.push({ path, marker, owner: 'live' })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM') inventory.push({ path, marker, owner: 'live' })
      else if (code === 'ESRCH') inventory.push({ path, marker, owner: 'dead' })
      else throw error
    }
  }
  // A live writer owns the whole recovery horizon. Reconcile nothing until
  // every inventoried owner is dead, otherwise one stale marker could delete
  // a same-revision artifact that another process is still publishing.
  if (inventory.some(item => item.owner === 'live')) return true
  for (const item of inventory) {
    reconcileDeadTemporary(root, item.marker)
    if (item.marker.kind === 'artifact') {
      reconcileDeadArtifact(root, item.marker.revisionHash)
    }
    rmSync(item.path)
    removed = true
  }
  if (removed) syncPath(root)
  // A legacy or externally damaged run may have lost the ownership marker.
  // Such private temporary bytes cannot be attributed safely, so fail closed
  // instead of certifying rollback or opening a writable store over them.
  return orphanTemporaryExists(root)
}

function readStoreEpoch(root: string): string {
  const path = join(root, STORE_EPOCH)
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 64) {
    throw new Error('AUTO_SKILL_STORE_EPOCH_INVALID')
  }
  const value = readFileSync(path, 'utf8')
  if (!STORE_EPOCH_VALUE.test(value.trim()) || value !== `${value.trim()}\n`) {
    throw new Error('AUTO_SKILL_STORE_EPOCH_INVALID')
  }
  return value.trim()
}

function ensureStoreEpoch(root: string): string {
  const path = join(root, STORE_EPOCH)
  if (existsSync(path)) return readStoreEpoch(root)
  const value = randomUUID()
  try {
    writeFileSync(path, `${value}\n`, { flag: 'wx', mode: 0o600 })
    syncPath(path)
    syncPath(root)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readStoreEpoch(root)
    throw error
  }
}

function rotateStoreEpoch(root: string): string {
  const path = join(root, STORE_EPOCH)
  const temporary = join(root, `.store-epoch-${process.pid}-${randomUUID()}.tmp`)
  const value = randomUUID()
  try {
    writeFileSync(temporary, `${value}\n`, { flag: 'wx', mode: 0o600 })
    syncPath(temporary)
    renameSync(temporary, path)
    syncPath(root)
    return value
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Read-only projection for `aisy doctor`; it never creates, chmods or recovers. */
export function inspectNodeAutoSkillStoreV2(input: {
  root: string
  enabled: boolean
}): Readonly<AutoSkillReadOnlyDoctorFinding> {
  const emptyReport = {
    schemaVersion: 2 as const,
    evidence: 0, pendingReply: 0, queued: 0, active: 0, quarantined: 0,
    forgetClaimed: 0, ambiguousNotifications: 0, rollbackBarrier: false,
  }
  if (!isAbsolute(input.root)) return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
  const root = resolve(input.root)
  if (root === parse(root).root) return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
  if (!existsSync(root)) return Object.freeze({
    state: input.enabled ? 'ready' as const : 'disabled' as const,
    ...emptyReport,
  })
  try {
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) {
      return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
    }
    readStoreEpoch(root)
    const mutationResidue = inspectMutationResidue(root)
    if (mutationResidue === 'corrupt') {
      return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
    }
    const rollbackBarrierPath = join(root, ROLLBACK_BARRIER)
    const rollbackBarrier = existsSync(rollbackBarrierPath)
    if (rollbackBarrier && readRollbackBarrier(rollbackBarrierPath) === null) {
      return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
    }
    const statePath = join(root, 'state-v2.json')
    if (!existsSync(statePath)) return Object.freeze({
      state: rollbackBarrier || mutationResidue === 'inflight'
        ? 'degraded' as const
        : 'ready' as const,
      ...emptyReport,
      rollbackBarrier,
    })
    const stateStat = lstatSync(statePath)
    if (!stateStat.isFile() || stateStat.isSymbolicLink() || (stateStat.mode & 0o077) !== 0) {
      return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
    }
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
    if (!validState(parsed)) return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
    const state = parsed
    for (const pointer of state.pointers) {
      const revision = state.revisions.find(item => item.revisionHash === pointer.activeHash)
      if (revision?.phase !== 'active') {
        return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
      }
      const directory = join(root, 'revisions', pointer.activeHash)
      const manifestPath = join(directory, 'manifest.json')
      const skillPath = join(directory, 'SKILL.md')
      if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() ||
        !existsSync(manifestPath) || !existsSync(skillPath) ||
        lstatSync(manifestPath).isSymbolicLink() || lstatSync(skillPath).isSymbolicLink() ||
        (lstatSync(manifestPath).mode & 0o077) !== 0 ||
        (lstatSync(skillPath).mode & 0o077) !== 0) {
        return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
      }
      const manifest = parseAutoSkillManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
      if (manifest === null || manifest.revisionHash !== pointer.activeHash ||
        readFileSync(skillPath, 'utf8') !== renderAutoSkillDocument(manifest)) {
        return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
      }
    }
    const report = {
      schemaVersion: 2 as const,
      evidence: state.evidence.filter(item => item.status === 'live').length,
      pendingReply: state.evidence.filter(item => item.status === 'pending_reply').length,
      queued: state.jobs.filter(item => item.phase === 'queued').length,
      active: state.revisions.filter(item => item.phase === 'active').length,
      quarantined: state.jobs.filter(item => item.phase === 'quarantined').length,
      forgetClaimed: state.revisions.filter(item =>
        item.phase === 'forget_claimed' || item.phase === 'purging').length,
      ambiguousNotifications: state.notifications.filter(item =>
        item.status === 'ambiguous' || item.status === 'claimed').length,
    }
    const degraded = rollbackBarrier || mutationResidue === 'inflight' ||
      report.pendingReply > 0 || report.forgetClaimed > 0 ||
      report.ambiguousNotifications > 0
    return Object.freeze({
      state: degraded
        ? 'degraded' as const
        : input.enabled
          ? 'ready' as const
          : 'disabled' as const,
      ...report,
      rollbackBarrier,
    })
  } catch {
    return Object.freeze({ state: 'corrupt' as const, ...emptyReport })
  }
}

export function makeNodeAutoSkillStoreV2(input: {
  root: string
  /** Reserved for the managed updater while the durable rollback barrier exists. */
  rollbackMaintenance?: boolean
  /** Deterministic crash-window injection for fault tests; production omits it. */
  fault?: (point: string) => void
}): NodeAutoSkillStoreV2 {
  if (!isAbsolute(input.root)) throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  const root = resolve(input.root)
  if (root === parse(root).root) throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  const rollbackBarrierPath = join(root, ROLLBACK_BARRIER)
  if (existsSync(rollbackBarrierPath) && input.rollbackMaintenance !== true) {
    throw new Error('AUTO_SKILL_ROLLBACK_BARRIER')
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
  const openedEpoch = ensureStoreEpoch(root)
  const revisionsRoot = join(root, 'revisions')
  if (existsSync(revisionsRoot) && lstatSync(revisionsRoot).isSymbolicLink()) {
    throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  }
  mkdirSync(revisionsRoot, { recursive: true, mode: 0o700 })
  chmodSync(revisionsRoot, 0o700)
  const statePath = join(root, 'state-v2.json')
  if (existsSync(statePath) && lstatSync(statePath).isSymbolicLink()) {
    throw new Error('AUTO_SKILL_STORE_CORRUPT')
  }

  const empty = (): StoreStateV2 => ({
    schemaVersion: 2,
    evidence: [],
    jobs: [],
    revisions: [],
    pointers: [],
    notifications: [],
    forgetClaims: [],
    rollbackCertificates: [],
  })

  let state = empty()
  let poisoned = false
  let lastPersistStateRenameReached = false
  let lastPersistDurabilityResolved = false
  let recoveredClaimedNotification = false
  if (existsSync(statePath)) {
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(statePath, 'utf8')) } catch {
      throw new Error('AUTO_SKILL_STORE_CORRUPT')
    }
    if (!validState(parsed)) throw new Error('AUTO_SKILL_STORE_CORRUPT')
    state = cloneState(parsed)
    for (const notification of state.notifications) {
      if (notification.status !== 'claimed') continue
      notification.status = 'ambiguous'
      recoveredClaimedNotification = true
    }
  }
  if (mutationInFlight(root)) throw new Error('AUTO_SKILL_MUTATION_IN_FLIGHT')

  const ensureWritable = (): void => {
    if (poisoned) throw new Error('AUTO_SKILL_STORE_POISONED')
    if (existsSync(rollbackBarrierPath) && input.rollbackMaintenance !== true) {
      poisoned = true
      throw new Error('AUTO_SKILL_ROLLBACK_BARRIER')
    }
    if (readStoreEpoch(root) !== openedEpoch) {
      poisoned = true
      throw new Error('AUTO_SKILL_STORE_FENCED')
    }
  }

  const mutationMarker = (marker: Readonly<
    { kind: 'state' } | { kind: 'artifact'; revisionHash: string }
  > = {
    kind: 'state',
  }): Readonly<{ path: string; temporaryName: string }> => {
    const markerId = randomUUID()
    const path = join(root, `${MUTATION_INFLIGHT_PREFIX}${process.pid}-${markerId}`)
    const temporaryName = marker.kind === 'state'
      ? `.state-${process.pid}-${markerId}.tmp`
      : `.revision-${markerId}.tmp`
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 2,
      ownerPid: process.pid,
      ...marker,
      temporaryName,
    })}\n`, { flag: 'wx', mode: 0o600 })
    syncPath(path)
    syncPath(root)
    return Object.freeze({ path, temporaryName })
  }

  const persist = (): void => {
    lastPersistStateRenameReached = false
    lastPersistDurabilityResolved = false
    ensureWritable()
    const inflight = mutationMarker()
    const temporary = join(root, inflight.temporaryName)
    const serialized = `${JSON.stringify(state)}\n`
    try {
      ensureWritable()
      writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 })
      syncPath(temporary)
      ensureWritable()
      input.fault?.('persist:before-state-rename')
      renameSync(temporary, statePath)
      lastPersistStateRenameReached = true
      input.fault?.('persist:after-state-rename')
      syncPath(root)
      lastPersistDurabilityResolved = true
    } catch (error) {
      poisoned = true
      if (lastPersistStateRenameReached) {
        try {
          // Try to converge the ambiguous rename before returning failure. If
          // the directory fsync or exact-byte verification still fails, retain
          // the durable marker so restart/rollback cannot overlook the window.
          syncPath(root)
          lastPersistDurabilityResolved = readFileSync(statePath, 'utf8') === serialized
        } catch {
          lastPersistDurabilityResolved = false
        }
      }
      throw error
    } finally {
      rmSync(temporary, { force: true })
      if (!lastPersistStateRenameReached || lastPersistDurabilityResolved) {
        rmSync(inflight.path, { force: true })
      }
    }
  }
  if (recoveredClaimedNotification) persist()

  const artifactDirectory = (revisionHash: string): string => {
    if (!HASH.test(revisionHash)) throw new Error('AUTO_SKILL_REVISION_INVALID')
    return join(revisionsRoot, revisionHash)
  }

  const writeArtifact = (
    manifest: AutoSkillManifestV1,
    renderedSkill: string,
    temporaryName: string,
  ): boolean => {
    const directory = artifactDirectory(manifest.revisionHash)
    if (existsSync(directory)) {
      if (lstatSync(directory).isSymbolicLink()) throw new Error('AUTO_SKILL_ARTIFACT_CONFLICT')
      const existingManifest = readFileSync(join(directory, 'manifest.json'), 'utf8')
      const existingSkill = readFileSync(join(directory, 'SKILL.md'), 'utf8')
      if (existingManifest !== `${JSON.stringify(manifest)}\n` || existingSkill !== renderedSkill) {
        throw new Error('AUTO_SKILL_ARTIFACT_CONFLICT')
      }
      return false
    }
    const temporary = join(revisionsRoot, temporaryName)
    let published = false
    try {
      mkdirSync(temporary, { mode: 0o700 })
      writeFileSync(join(temporary, 'manifest.json'), `${JSON.stringify(manifest)}\n`, {
        flag: 'wx', mode: 0o600,
      })
      writeFileSync(join(temporary, 'SKILL.md'), renderedSkill, { flag: 'wx', mode: 0o600 })
      syncPath(join(temporary, 'manifest.json'))
      syncPath(join(temporary, 'SKILL.md'))
      syncPath(temporary)
      renameSync(temporary, directory)
      published = true
      syncPath(revisionsRoot)
      return true
    } catch (error) {
      if (published) {
        rmSync(directory, { recursive: true, force: true })
        syncPath(revisionsRoot)
      }
      throw error
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }

  const readArtifact = (revisionHash: string): AutoSkillActivationView => {
    const directory = artifactDirectory(revisionHash)
    if (lstatSync(directory).isSymbolicLink()) throw new Error('AUTO_SKILL_ARTIFACT_CORRUPT')
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) } catch {
      throw new Error('AUTO_SKILL_ARTIFACT_CORRUPT')
    }
    const manifest = parseAutoSkillManifest(parsed)
    if (manifest === null || manifest.revisionHash !== revisionHash) {
      throw new Error('AUTO_SKILL_ARTIFACT_CORRUPT')
    }
    const renderedSkill = readFileSync(join(directory, 'SKILL.md'), 'utf8')
    if (renderedSkill !== renderAutoSkillDocument(manifest)) {
      throw new Error('AUTO_SKILL_ARTIFACT_CORRUPT')
    }
    return Object.freeze({
      manifest: Object.freeze(manifest),
      renderedSkill,
    })
  }

  const jobById = (jobId: string): AutoSkillJobRecordV2 => {
    const job = state.jobs.find(item => item.jobId === jobId)
    if (job === undefined) throw new Error('AUTO_SKILL_JOB_NOT_FOUND')
    return job
  }

  const updateJob = (jobId: string, replace: AutoSkillJobRecordV2): void => {
    const index = state.jobs.findIndex(item => item.jobId === jobId)
    if (index < 0) throw new Error('AUTO_SKILL_JOB_NOT_FOUND')
    state.jobs[index] = replace
  }

  const pointerFor = (scopeKey: string, skillIdentity: string): PointerRecord | undefined =>
    state.pointers.find(item => item.pointerKey === pointerKey(scopeKey, skillIdentity))

  const confirmEvidence = (evidence: VerifiedWorkflowEvidenceV1):
    | { kind: 'duplicate' | 'counted' }
    | { kind: 'queued'; jobId: string } => {
    const matching = state.evidence.filter(item => item.status === 'live' &&
      item.value.scopeKey === evidence.scopeKey &&
      item.value.skillIdentity === evidence.skillIdentity &&
      item.value.workflowFingerprint === evidence.workflowFingerprint)
    const independent: EvidenceRecord[] = []
    const sessions = new Set<string>()
    for (const item of matching) {
      if (sessions.has(item.value.sessionId)) continue
      sessions.add(item.value.sessionId)
      independent.push(item)
    }
    if (independent.length < 2) return { kind: 'counted' }
    const existing = state.jobs.find(item => item.scopeKey === evidence.scopeKey &&
      item.skillIdentity === evidence.skillIdentity &&
      item.workflowFingerprint === evidence.workflowFingerprint &&
      item.phase !== 'forgotten')
    if (existing !== undefined) return { kind: 'duplicate' }
    const evidenceIds = [independent[0]!.value.evidenceId, independent[1]!.value.evidenceId]
      .sort() as [string, string]
    const jobId = hash('aisy-auto-skill-job/v1', JSON.stringify([
      evidence.scopeKey, evidence.skillIdentity, evidenceIds,
    ]))
    const pointer = pointerFor(evidence.scopeKey, evidence.skillIdentity)
    state.jobs.push({
      jobId,
      scopeKey: evidence.scopeKey,
      skillIdentity: evidence.skillIdentity,
      workflowFingerprint: evidence.workflowFingerprint,
      evidenceIds,
      phase: 'queued',
      baseRevisionHash: pointer?.activeHash ?? null,
    })
    return { kind: 'queued', jobId }
  }

  return Object.freeze<NodeAutoSkillStoreV2>({
    stage(evidence) {
      ensureWritable()
      const evidenceHash = hash('aisy-auto-skill-forgotten-evidence/v1', evidence.evidenceId)
      if (state.forgetClaims.some(claim => claim.evidenceHashes.includes(evidenceHash) ||
        (claim.phase !== 'tombstoned' && claim.sourceId !== undefined &&
          (claim.sourceKind === 'session'
            ? evidence.sessionId === claim.sourceId
            : evidence.scope.projectId === claim.sourceId)))) {
        return { kind: 'duplicate' }
      }
      if (state.evidence.some(item => item.value.evidenceId === evidence.evidenceId)) {
        return { kind: 'duplicate' }
      }
      const receipts = new Set(evidence.steps.map(step => step.receiptId))
      if (state.evidence.some(item => item.value.steps.some(step => receipts.has(step.receiptId)))) {
        return { kind: 'duplicate' }
      }
      state.evidence.push({ value: structuredClone(evidence), status: 'pending_reply' })
      persist()
      return { kind: 'staged' }
    },

    confirmReply(identity) {
      ensureWritable()
      const pending = state.evidence.find(item => item.status === 'pending_reply' &&
        item.value.evidenceId === identity.evidenceId &&
        item.value.sessionId === identity.sessionId && item.value.turnId === identity.turnId)
      if (pending === undefined) return { kind: 'duplicate' }
      pending.status = 'live'
      const outcome = confirmEvidence(pending.value)
      persist()
      return outcome
    },

    nextWork() {
      const job = state.jobs.find(item =>
        item.phase === 'queued' || item.phase === 'generated' ||
        item.phase === 'validated' || item.phase === 'shadow_verified' ||
        item.phase === 'prepared')
      return job === undefined ? null : Object.freeze(structuredClone(job))
    },

    evidenceFor(jobId) {
      const job = jobById(jobId)
      const values = job.evidenceIds.map(id => state.evidence.find(item =>
        item.status === 'live' && item.value.evidenceId === id)?.value)
      if (values[0] === undefined || values[1] === undefined) {
        throw new Error('AUTO_SKILL_EVIDENCE_MISSING')
      }
      return Object.freeze([structuredClone(values[0]), structuredClone(values[1])])
    },

    advanceJob({ jobId, expected, next, draft }) {
      ensureWritable()
      const job = jobById(jobId)
      if (job.phase !== expected) throw new Error('AUTO_SKILL_JOB_CAS_FAILED')
      const updated: AutoSkillJobRecordV2 = Object.freeze({
        ...job,
        phase: next,
        ...(draft === undefined ? {} : { draft: structuredClone(draft) }),
      })
      updateJob(jobId, updated)
      persist()
      return structuredClone(updated)
    },

    quarantine(jobId, reason) {
      ensureWritable()
      const job = jobById(jobId)
      if (job.phase === 'active' || job.phase === 'forgotten') return
      updateJob(jobId, { ...job, phase: 'quarantined', quarantineReason: reason.slice(0, 128) })
      persist()
    },

    prepare({ jobId, manifest, renderedSkill }) {
      ensureWritable()
      const job = jobById(jobId)
      if (job.phase !== 'shadow_verified' || job.skillIdentity !== manifest.skillIdentity ||
        job.scopeKey !== manifest.scopeKey) throw new Error('AUTO_SKILL_PREPARE_CAS_FAILED')
      const pointer = pointerFor(job.scopeKey, job.skillIdentity)
      if ((pointer?.activeHash ?? null) !== job.baseRevisionHash) {
        throw new Error('AUTO_SKILL_REVISION_CONFLICT')
      }
      const inflight = mutationMarker({ kind: 'artifact', revisionHash: manifest.revisionHash })
      let artifactCreated = false
      lastPersistStateRenameReached = false
      try {
        ensureWritable()
        artifactCreated = writeArtifact(manifest, renderedSkill, inflight.temporaryName)
        ensureWritable()
        const evidence = this.evidenceFor(jobId)
        const revision: AutoSkillRevisionRecordV2 = {
          revisionHash: manifest.revisionHash,
          scopeKey: job.scopeKey,
          skillIdentity: job.skillIdentity,
          jobId,
          phase: 'prepared',
          previousHash: pointer?.activeHash ?? null,
          sourceSessionIds: [evidence[0].sessionId, evidence[1].sessionId],
          sourceProjectId: evidence[0].scope.projectId,
        }
        const existing = state.revisions.find(item => item.revisionHash === revision.revisionHash)
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(revision)) {
          throw new Error('AUTO_SKILL_REVISION_CONFLICT')
        }
        if (existing === undefined) state.revisions.push(revision)
        updateJob(jobId, { ...job, phase: 'prepared', revisionHash: manifest.revisionHash })
        persist()
        return structuredClone(revision)
      } catch (error) {
        if (artifactCreated && !lastPersistStateRenameReached) {
          rmSync(artifactDirectory(manifest.revisionHash), { recursive: true, force: true })
          syncPath(revisionsRoot)
        }
        throw error
      } finally {
        if (!lastPersistStateRenameReached || lastPersistDurabilityResolved) {
          rmSync(inflight.path, { force: true })
        }
      }
    },

    activate(jobId, revisionHash) {
      ensureWritable()
      const job = jobById(jobId)
      const revisionIndex = state.revisions.findIndex(item => item.revisionHash === revisionHash)
      if (job.phase !== 'prepared' || job.revisionHash !== revisionHash || revisionIndex < 0) {
        throw new Error('AUTO_SKILL_ACTIVATION_CAS_FAILED')
      }
      const revision = state.revisions[revisionIndex]!
      if (revision.phase !== 'prepared') throw new Error('AUTO_SKILL_ACTIVATION_CAS_FAILED')
      const pointer = pointerFor(job.scopeKey, job.skillIdentity)
      if ((pointer?.activeHash ?? null) !== job.baseRevisionHash) {
        throw new Error('AUTO_SKILL_REVISION_CONFLICT')
      }
      const key = pointerKey(job.scopeKey, job.skillIdentity)
      const nextPointer: PointerRecord = {
        pointerKey: key,
        scopeKey: job.scopeKey,
        skillIdentity: job.skillIdentity,
        activeHash: revisionHash,
        previousHash: pointer?.activeHash ?? null,
      }
      const pointerIndex = state.pointers.findIndex(item => item.pointerKey === key)
      if (pointerIndex < 0) state.pointers.push(nextPointer)
      else state.pointers[pointerIndex] = nextPointer
      if (revision.previousHash !== null) {
        const previousIndex = state.revisions.findIndex(item =>
          item.revisionHash === revision.previousHash && item.phase === 'active')
        if (previousIndex >= 0) {
          state.revisions[previousIndex] = {
            ...state.revisions[previousIndex]!, phase: 'demoted',
          }
        }
      }
      state.revisions[revisionIndex] = { ...revision, phase: 'active' }
      updateJob(jobId, { ...job, phase: 'active' })
      const artifact = readArtifact(revisionHash)
      const notificationId = hash('aisy-auto-skill-notification/v1', revisionHash)
      if (!state.notifications.some(item => item.id === notificationId)) {
        state.notifications.push({
          id: notificationId,
          revisionHash,
          title: artifact.manifest.title.slice(0, 200),
          status: 'pending',
        })
      }
      persist()
      return structuredClone(state.revisions[revisionIndex]!)
    },

    active(scopeKey, skillIdentity) {
      ensureWritable()
      const pointer = pointerFor(scopeKey, skillIdentity)
      if (pointer === undefined) return null
      const revision = state.revisions.find(item => item.revisionHash === pointer.activeHash)
      if (revision?.phase !== 'active') return null
      return readArtifact(pointer.activeHash)
    },

    activeForScope(scopeKey) {
      ensureWritable()
      if (!HASH.test(scopeKey)) return Object.freeze([])
      return Object.freeze(state.pointers
        .filter(pointer => pointer.scopeKey === scopeKey)
        .sort((left, right) => left.skillIdentity.localeCompare(right.skillIdentity))
        .flatMap(pointer => {
          const revision = state.revisions.find(item => item.revisionHash === pointer.activeHash)
          return revision?.phase === 'active' ? [readArtifact(pointer.activeHash)] : []
        }))
    },

    permanentFailure(revisionHash, failure) {
      ensureWritable()
      const index = state.revisions.findIndex(item => item.revisionHash === revisionHash)
      if (index < 0 || state.revisions[index]!.phase !== 'active') return
      const revision = state.revisions[index]!
      const pointer = pointerFor(revision.scopeKey, revision.skillIdentity)
      if (pointer?.activeHash !== revisionHash) return
      state.revisions[index] = { ...revision, phase: 'demoted', failure }
      if (pointer.previousHash === null) {
        state.pointers = state.pointers.filter(item => item.pointerKey !== pointer.pointerKey)
      } else {
        pointer.activeHash = pointer.previousHash
        pointer.previousHash = state.revisions.find(item =>
          item.revisionHash === pointer.activeHash)?.previousHash ?? null
        const previousIndex = state.revisions.findIndex(item =>
          item.revisionHash === pointer.activeHash)
        if (previousIndex >= 0) {
          state.revisions[previousIndex] = {
            ...state.revisions[previousIndex]!, phase: 'active',
          }
        }
      }
      persist()
    },

    claimBySource(selector) {
      ensureWritable()
      const hasSession = typeof selector.sessionId === 'string' && selector.sessionId.length > 0
      const hasProject = typeof selector.projectId === 'string' && selector.projectId.length > 0
      if (hasSession === hasProject) throw new Error('AUTO_SKILL_FORGET_SELECTOR_INVALID')
      const sourceKind = hasSession ? 'session' as const : 'project' as const
      const sourceId = hasSession ? selector.sessionId! : selector.projectId!
      const sourceIdHash = hash('aisy-auto-skill-forget-source/v1', sourceId)
      const existing = state.forgetClaims.find(item => item.sourceKind === sourceKind &&
        item.sourceIdHash === sourceIdHash && item.phase !== 'tombstoned')
      if (existing !== undefined) return { claimId: existing.claimId, affected: existing.revisionHashes.length }
      const dependentJobs = state.jobs.filter(job => job.phase !== 'forgotten' &&
        job.evidenceIds.some(evidenceId => {
          const evidence = state.evidence.find(item => item.value.evidenceId === evidenceId)?.value
          return evidence !== undefined && (sourceKind === 'session'
            ? evidence.sessionId === sourceId
            : evidence.scope.projectId === sourceId)
        }))
      const dependentJobIds = new Set(dependentJobs.map(job => job.jobId))
      const affected = state.revisions.filter(revision => revision.phase !== 'tombstoned' &&
        (dependentJobIds.has(revision.jobId) || (sourceKind === 'session'
          ? revision.sourceSessionIds.includes(sourceId)
          : revision.sourceProjectId === sourceId)))
      const hashes = affected.map(item => item.revisionHash).sort()
      const forgottenEvidenceIds = new Set<string>()
      for (const job of dependentJobs) {
        updateJob(job.jobId, { ...job, phase: 'forgotten' })
        for (const evidenceId of job.evidenceIds) {
          forgottenEvidenceIds.add(evidenceId)
          const record = state.evidence.find(item => item.value.evidenceId === evidenceId)
          if (record !== undefined) record.status = 'forget_claimed'
        }
      }
      for (const revision of affected) {
        const index = state.revisions.findIndex(item => item.revisionHash === revision.revisionHash)
        state.revisions[index] = { ...revision, phase: 'forget_claimed' }
        state.pointers = state.pointers
          .filter(item => item.activeHash !== revision.revisionHash)
          .map(item => item.previousHash === revision.revisionHash
            ? { ...item, previousHash: null }
            : item)
        const job = jobById(revision.jobId)
        if (job.phase !== 'forgotten') updateJob(job.jobId, { ...job, phase: 'forgotten' })
      }
      const affectedRevisions = new Set(hashes)
      state.notifications = state.notifications.filter(notification =>
        notification.status !== 'pending' || !affectedRevisions.has(notification.revisionHash))
      for (const record of state.evidence) {
        if ((sourceKind === 'session' && record.value.sessionId === sourceId) ||
          (sourceKind === 'project' && record.value.scope.projectId === sourceId)) {
          forgottenEvidenceIds.add(record.value.evidenceId)
          record.status = 'forget_claimed'
        }
      }
      const evidenceHashes = [...forgottenEvidenceIds]
        .map(id => hash('aisy-auto-skill-forgotten-evidence/v1', id))
        .sort()
      const claimId = hash('aisy-auto-skill-forget-claim/v1', JSON.stringify([
        sourceKind, sourceIdHash, evidenceHashes, hashes,
      ]))
      state.forgetClaims.push({
        claimId, sourceKind, sourceIdHash, sourceId, evidenceHashes,
        revisionHashes: hashes, phase: 'forget_claimed',
      })
      persist()
      return { claimId, affected: hashes.length }
    },

    purgeClaim(claimId) {
      ensureWritable()
      const claim = state.forgetClaims.find(item => item.claimId === claimId)
      if (claim === undefined) throw new Error('AUTO_SKILL_FORGET_CLAIM_MISSING')
      if (claim.phase === 'tombstoned') return
      claim.phase = 'purging'
      persist()
      for (const revisionHash of claim.revisionHashes) {
        rmSync(artifactDirectory(revisionHash), { recursive: true, force: true })
        const revisionIndex = state.revisions.findIndex(item => item.revisionHash === revisionHash)
        if (revisionIndex >= 0) {
          const revision = state.revisions[revisionIndex]!
          state.revisions[revisionIndex] = {
            ...revision,
            phase: 'tombstoned',
            sourceSessionIds: revision.sourceSessionIds.map(id =>
              hash('aisy-auto-skill-tombstone-session/v1', id)) as [string, string],
            sourceProjectId: hash(
              'aisy-auto-skill-tombstone-project/v1', revision.sourceProjectId,
            ),
          }
        }
      }
      state.evidence = state.evidence.filter(item => item.status !== 'forget_claimed')
      claim.phase = 'tombstoned'
      delete claim.sourceId
      persist()
    },

    recoverForgetClaims(sourceArchived) {
      const pending = state.forgetClaims
        .filter(claim => claim.phase === 'purging' ||
          (claim.phase === 'forget_claimed' && claim.sourceId !== undefined &&
            sourceArchived?.({ kind: claim.sourceKind, id: claim.sourceId }) === true))
        .map(claim => claim.claimId)
      for (const claimId of pending) this.purgeClaim(claimId)
      return pending.length
    },

    issueRollbackCertificate(targetCommit) {
      ensureWritable()
      if (!SAFE_COMMIT.test(targetCommit)) throw new Error('AUTO_SKILL_TARGET_COMMIT_INVALID')
      const dependencies = state.evidence.length + state.jobs.filter(item =>
        item.phase !== 'forgotten').length + state.revisions.filter(item =>
        item.phase !== 'tombstoned').length + state.pointers.length
      if (dependencies !== 0 || state.forgetClaims.some(item => item.phase !== 'tombstoned')) return null
      const stateHash = rollbackStateHash(state)
      const certificateId = hash(
        'aisy-auto-skill-rollback-certificate/v1',
        JSON.stringify([stateHash, targetCommit]),
      )
      const certificate = { certificateId, stateHash, targetCommit }
      const existing = state.rollbackCertificates.find(item =>
        item.stateHash === stateHash && item.targetCommit === targetCommit)
      if (existing !== undefined) return Object.freeze(structuredClone(existing))
      state.rollbackCertificates.push(certificate)
      persist()
      return Object.freeze(certificate)
    },

    verifyRollbackCertificate(certificateId, targetCommit) {
      return stateHasRollbackCertificate(state, certificateId, targetCommit)
    },

    claimNotification() {
      ensureWritable()
      const item = state.notifications.find(record => record.status === 'pending')
      if (item === undefined) return null
      item.status = 'claimed'
      persist()
      return Object.freeze(structuredClone(item))
    },

    completeNotification(id, outcome) {
      ensureWritable()
      const item = state.notifications.find(record => record.id === id)
      if (item === undefined || item.status !== 'claimed') {
        throw new Error('AUTO_SKILL_NOTIFICATION_CAS_FAILED')
      }
      item.status = outcome
      persist()
    },

    doctor() {
      return Object.freeze({
        schemaVersion: 2,
        evidence: state.evidence.filter(item => item.status === 'live').length,
        pendingReply: state.evidence.filter(item => item.status === 'pending_reply').length,
        queued: state.jobs.filter(item => item.phase === 'queued').length,
        active: state.revisions.filter(item => item.phase === 'active').length,
        quarantined: state.jobs.filter(item => item.phase === 'quarantined').length,
        forgetClaimed: state.revisions.filter(item =>
          item.phase === 'forget_claimed' || item.phase === 'purging').length,
        ambiguousNotifications: state.notifications.filter(item =>
          item.status === 'ambiguous').length,
      })
    },
  })
}

function readRollbackBarrier(path: string): NodeAutoSkillRollbackBarrier | null {
  if (!existsSync(path)) return null
  let value: unknown
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return null
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch { return null }
  const raw = record(value)
  if (raw === null || raw['schemaVersion'] !== 1 ||
    typeof raw['targetCommit'] !== 'string' || !SAFE_COMMIT.test(raw['targetCommit'])) return null
  if (raw['phase'] === 'preparing' &&
    onlyKeys(raw, ['schemaVersion', 'phase', 'targetCommit'])) {
    return Object.freeze({ phase: 'preparing', targetCommit: raw['targetCommit'] })
  }
  if (raw['phase'] === 'certified' &&
    onlyKeys(raw, ['schemaVersion', 'phase', 'certificateId', 'targetCommit']) &&
    typeof raw['certificateId'] === 'string' && HASH.test(raw['certificateId'])) {
    return Object.freeze({
      phase: 'certified',
      certificateId: raw['certificateId'],
      targetCommit: raw['targetCommit'],
    })
  }
  return null
}

/**
 * Read-only startup classification. Only a complete certificate bound to the
 * exact persisted state is safe to treat as a managed rollback pause.
 */
export function inspectNodeAutoSkillRollbackBarrier(input: {
  root: string
}): NodeAutoSkillRollbackBarrierStatus {
  if (!isAbsolute(input.root)) return 'unsafe'
  const root = resolve(input.root)
  if (root === parse(root).root) return 'unsafe'
  if (!existsSync(root)) return 'absent'
  try {
    const rootInfo = lstatSync(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0) {
      return 'unsafe'
    }
    const barrierPath = join(root, ROLLBACK_BARRIER)
    if (!existsSync(barrierPath)) return 'absent'
    const barrier = readRollbackBarrier(barrierPath)
    if (barrier === null || barrier.phase !== 'certified' ||
      inspectMutationResidue(root) !== 'none' ||
      inspectNodeAutoSkillStoreV2({ root, enabled: true }).state === 'corrupt') return 'unsafe'
    const statePath = join(root, 'state-v2.json')
    if (!existsSync(statePath)) return 'unsafe'
    const stateInfo = lstatSync(statePath)
    if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || (stateInfo.mode & 0o077) !== 0) {
      return 'unsafe'
    }
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
    if (!validState(parsed) ||
      !stateHasRollbackCertificate(parsed, barrier.certificateId, barrier.targetCommit)) {
      return 'unsafe'
    }
    return 'certified'
  } catch {
    return 'unsafe'
  }
}

export function prepareNodeAutoSkillRollback(input: {
  root: string
  targetCommit: string
}): NodeAutoSkillRollbackAuthorization {
  if (!SAFE_COMMIT.test(input.targetCommit)) throw new Error('AUTO_SKILL_TARGET_COMMIT_INVALID')
  if (!isAbsolute(input.root)) throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  const root = resolve(input.root)
  if (root === parse(root).root || (existsSync(root) && lstatSync(root).isSymbolicLink())) {
    throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  }
  // An absent store is materialized before the barrier; an existing one is
  // validated after quiescence so restart recovery cannot race an old writer.
  if (!existsSync(root)) makeNodeAutoSkillStoreV2({ root, rollbackMaintenance: true })
  const barrierPath = join(root, ROLLBACK_BARRIER)
  const existing = readRollbackBarrier(barrierPath)
  if (existing !== null) {
    if (existing.targetCommit !== input.targetCommit) {
      throw new Error('AUTO_SKILL_ROLLBACK_BARRIER_INVALID')
    }
    if (existing.phase === 'certified') {
      if (mutationInFlight(root) ||
        !makeNodeAutoSkillStoreV2({ root, rollbackMaintenance: true })
        .verifyRollbackCertificate(existing.certificateId, input.targetCommit)) {
        throw new Error('AUTO_SKILL_ROLLBACK_BARRIER_INVALID')
      }
      return Object.freeze({
        certificateId: existing.certificateId,
        targetCommit: existing.targetCommit,
      })
    }
  } else if (existsSync(barrierPath)) {
    throw new Error('AUTO_SKILL_ROLLBACK_BARRIER_INVALID')
  } else {
    makeNodeAutoSkillStoreV2({ root, rollbackMaintenance: true })
    writeFileSync(barrierPath, `${JSON.stringify({
      schemaVersion: 1,
      phase: 'preparing',
      targetCommit: input.targetCommit,
    })}\n`, { flag: 'wx', mode: 0o600 })
    syncPath(barrierPath)
    syncPath(root)
  }
  try {
    if (mutationInFlight(root)) {
      throw new Error('AUTO_SKILL_MUTATION_IN_FLIGHT')
    }
    rotateStoreEpoch(root)
    const store = makeNodeAutoSkillStoreV2({ root, rollbackMaintenance: true })
    store.recoverForgetClaims()
    const certificate = store.issueRollbackCertificate(input.targetCommit)
    if (certificate === null) throw new Error('AUTO_SKILL_ROLLBACK_DEPENDENCIES')
    const temporary = join(root, `.rollback-barrier-${process.pid}-${randomUUID()}.tmp`)
    writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: 1,
      phase: 'certified',
      certificateId: certificate.certificateId,
      targetCommit: input.targetCommit,
    })}\n`, { flag: 'wx', mode: 0o600 })
    syncPath(temporary)
    renameSync(temporary, barrierPath)
    syncPath(root)
    return Object.freeze({
      certificateId: certificate.certificateId,
      targetCommit: input.targetCommit,
    })
  } catch (error) {
    rmSync(barrierPath, { force: true })
    syncPath(root)
    throw error
  }
}

export function verifyNodeAutoSkillRollback(input: {
  root: string
  authorization: NodeAutoSkillRollbackAuthorization
}): boolean {
  try {
    const root = resolve(input.root)
    const barrier = readRollbackBarrier(join(root, ROLLBACK_BARRIER))
    if (barrier === null || barrier.phase !== 'certified' ||
      barrier.certificateId !== input.authorization.certificateId ||
      barrier.targetCommit !== input.authorization.targetCommit ||
      mutationInFlight(root)) return false
    return makeNodeAutoSkillStoreV2({ root, rollbackMaintenance: true })
      .verifyRollbackCertificate(barrier.certificateId, barrier.targetCommit)
  } catch {
    return false
  }
}

/**
 * Explicit roll-forward edge. It exists only in a v2-aware binary and removes
 * the barrier after the managed active generation has moved away from the
 * certified downgrade target.
 */
export function resumeNodeAutoSkillWritesAfterRollForward(input: {
  root: string
  currentCommit: string
}): boolean {
  if (!SAFE_COMMIT.test(input.currentCommit)) throw new Error('AUTO_SKILL_TARGET_COMMIT_INVALID')
  if (!isAbsolute(input.root)) throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  const root = resolve(input.root)
  if (root === parse(root).root) throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  const barrierPath = join(root, ROLLBACK_BARRIER)
  const barrier = readRollbackBarrier(barrierPath)
  if (barrier === null) {
    if (existsSync(barrierPath)) throw new Error('AUTO_SKILL_ROLLBACK_BARRIER_INVALID')
    return false
  }
  if (barrier.phase !== 'certified' || barrier.targetCommit === input.currentCommit ||
    mutationInFlight(root) ||
    !makeNodeAutoSkillStoreV2({ root, rollbackMaintenance: true })
      .verifyRollbackCertificate(barrier.certificateId, barrier.targetCommit)) {
    throw new Error('AUTO_SKILL_ROLLFORWARD_REFUSED')
  }
  rotateStoreEpoch(root)
  rmSync(barrierPath)
  syncPath(root)
  return true
}

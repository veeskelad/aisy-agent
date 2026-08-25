import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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
} from '@aisy/core'
import type {
  AutoSkillManifestV1,
  SkillRecipeDraftV1,
  VerifiedWorkflowEvidenceV1,
} from '@aisy/core'

const HASH = /^[a-f0-9]{64}$/u
const SAFE_COMMIT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

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
  readonly queued: number
  readonly active: number
  readonly quarantined: number
  readonly forgetClaimed: number
  readonly ambiguousNotifications: number
}

interface EvidenceRecord {
  value: VerifiedWorkflowEvidenceV1
  status: 'live' | 'forget_claimed'
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
  observe(evidence: VerifiedWorkflowEvidenceV1):
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
  permanentFailure(revisionHash: string, failure: AutoSkillPermanentFailure): void
  claimBySource(input: { sessionId?: string; projectId?: string }): { claimId: string; affected: number }
  purgeClaim(claimId: string): void
  issueRollbackCertificate(targetCommit: string): Readonly<RollbackCertificateRecord> | null
  claimNotification(): Readonly<NotificationRecord> | null
  completeNotification(id: string, outcome: 'sent' | 'ambiguous'): void
  doctor(): Readonly<AutoSkillDoctorReport>
}

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
      (rawItem['status'] === 'live' || rawItem['status'] === 'forget_claimed') &&
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
      'claimId', 'sourceKind', 'sourceIdHash', 'revisionHashes', 'phase',
    ]) && typeof rawItem['claimId'] === 'string' && HASH.test(rawItem['claimId']) &&
      (rawItem['sourceKind'] === 'session' || rawItem['sourceKind'] === 'project') &&
      typeof rawItem['sourceIdHash'] === 'string' && HASH.test(rawItem['sourceIdHash']) &&
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
    candidate.jobs.some(item => item.evidenceIds.some(id => !evidenceIds.has(id))) ||
    candidate.revisions.some(item => !jobIds.has(item.jobId))) return false
  const revisionIds = new Set(candidate.revisions.map(item => item.revisionHash))
  return revisionIds.size === candidate.revisions.length && candidate.pointers.every(item =>
    revisionIds.has(item.activeHash) && (item.previousHash === null || revisionIds.has(item.previousHash))) &&
    candidate.notifications.every(item => revisionIds.has(item.revisionHash))
}

function cloneState(state: StoreStateV2): StoreStateV2 {
  return structuredClone(state)
}

export function makeNodeAutoSkillStoreV2(input: { root: string }): NodeAutoSkillStoreV2 {
  if (!isAbsolute(input.root)) throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  const root = resolve(input.root)
  if (root === parse(root).root) throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('AUTO_SKILL_ROOT_UNSAFE')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  chmodSync(root, 0o700)
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

  const persist = (): void => {
    const temporary = join(root, `.state-${process.pid}-${randomUUID()}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 })
    syncPath(temporary)
    renameSync(temporary, statePath)
    chmodSync(statePath, 0o600)
    syncPath(root)
  }
  if (recoveredClaimedNotification) persist()

  const artifactDirectory = (revisionHash: string): string => {
    if (!HASH.test(revisionHash)) throw new Error('AUTO_SKILL_REVISION_INVALID')
    return join(revisionsRoot, revisionHash)
  }

  const writeArtifact = (manifest: AutoSkillManifestV1, renderedSkill: string): void => {
    const directory = artifactDirectory(manifest.revisionHash)
    if (existsSync(directory)) {
      if (lstatSync(directory).isSymbolicLink()) throw new Error('AUTO_SKILL_ARTIFACT_CONFLICT')
      const existingManifest = readFileSync(join(directory, 'manifest.json'), 'utf8')
      const existingSkill = readFileSync(join(directory, 'SKILL.md'), 'utf8')
      if (existingManifest !== `${JSON.stringify(manifest)}\n` || existingSkill !== renderedSkill) {
        throw new Error('AUTO_SKILL_ARTIFACT_CONFLICT')
      }
      return
    }
    const temporary = join(revisionsRoot, `.revision-${randomUUID()}.tmp`)
    mkdirSync(temporary, { mode: 0o700 })
    writeFileSync(join(temporary, 'manifest.json'), `${JSON.stringify(manifest)}\n`, {
      flag: 'wx', mode: 0o600,
    })
    writeFileSync(join(temporary, 'SKILL.md'), renderedSkill, { flag: 'wx', mode: 0o600 })
    syncPath(join(temporary, 'manifest.json'))
    syncPath(join(temporary, 'SKILL.md'))
    syncPath(temporary)
    renameSync(temporary, directory)
    syncPath(revisionsRoot)
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
    return Object.freeze({
      manifest: Object.freeze(manifest),
      renderedSkill: readFileSync(join(directory, 'SKILL.md'), 'utf8'),
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

  return Object.freeze<NodeAutoSkillStoreV2>({
    observe(evidence) {
      if (state.evidence.some(item => item.value.evidenceId === evidence.evidenceId)) {
        return { kind: 'duplicate' }
      }
      const receipts = new Set(evidence.steps.map(step => step.receiptId))
      if (state.evidence.some(item => item.value.steps.some(step => receipts.has(step.receiptId)))) {
        return { kind: 'duplicate' }
      }
      state.evidence.push({ value: structuredClone(evidence), status: 'live' })
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
      if (independent.length < 2) {
        persist()
        return { kind: 'counted' }
      }
      const existing = state.jobs.find(item => item.scopeKey === evidence.scopeKey &&
        item.skillIdentity === evidence.skillIdentity && item.phase !== 'forgotten')
      if (existing !== undefined) {
        persist()
        return { kind: 'duplicate' }
      }
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
      persist()
      return { kind: 'queued', jobId }
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
      const job = jobById(jobId)
      if (job.phase === 'active' || job.phase === 'forgotten') return
      updateJob(jobId, { ...job, phase: 'quarantined', quarantineReason: reason.slice(0, 128) })
      persist()
    },

    prepare({ jobId, manifest, renderedSkill }) {
      const job = jobById(jobId)
      if (job.phase !== 'shadow_verified' || job.skillIdentity !== manifest.skillIdentity ||
        job.scopeKey !== manifest.scopeKey) throw new Error('AUTO_SKILL_PREPARE_CAS_FAILED')
      const pointer = pointerFor(job.scopeKey, job.skillIdentity)
      if ((pointer?.activeHash ?? null) !== job.baseRevisionHash) {
        throw new Error('AUTO_SKILL_REVISION_CONFLICT')
      }
      writeArtifact(manifest, renderedSkill)
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
    },

    activate(jobId, revisionHash) {
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
      const pointer = pointerFor(scopeKey, skillIdentity)
      if (pointer === undefined) return null
      const revision = state.revisions.find(item => item.revisionHash === pointer.activeHash)
      if (revision?.phase !== 'active') return null
      return readArtifact(pointer.activeHash)
    },

    permanentFailure(revisionHash, failure) {
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
      for (const job of dependentJobs) {
        updateJob(job.jobId, { ...job, phase: 'forgotten' })
        for (const evidenceId of job.evidenceIds) {
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
      for (const record of state.evidence) {
        if ((sourceKind === 'session' && record.value.sessionId === sourceId) ||
          (sourceKind === 'project' && record.value.scope.projectId === sourceId)) {
          record.status = 'forget_claimed'
        }
      }
      const claimId = hash('aisy-auto-skill-forget-claim/v1', JSON.stringify([
        sourceKind, sourceIdHash, hashes,
      ]))
      state.forgetClaims.push({
        claimId, sourceKind, sourceIdHash, revisionHashes: hashes, phase: 'forget_claimed',
      })
      persist()
      return { claimId, affected: hashes.length }
    },

    purgeClaim(claimId) {
      const claim = state.forgetClaims.find(item => item.claimId === claimId)
      if (claim === undefined) throw new Error('AUTO_SKILL_FORGET_CLAIM_MISSING')
      if (claim.phase === 'tombstoned') return
      claim.phase = 'purging'
      persist()
      for (const revisionHash of claim.revisionHashes) {
        rmSync(artifactDirectory(revisionHash), { recursive: true, force: true })
        const revisionIndex = state.revisions.findIndex(item => item.revisionHash === revisionHash)
        if (revisionIndex >= 0) {
          state.revisions[revisionIndex] = {
            ...state.revisions[revisionIndex]!, phase: 'tombstoned',
          }
        }
      }
      state.evidence = state.evidence.filter(item => item.status !== 'forget_claimed')
      claim.phase = 'tombstoned'
      persist()
    },

    issueRollbackCertificate(targetCommit) {
      if (!SAFE_COMMIT.test(targetCommit)) throw new Error('AUTO_SKILL_TARGET_COMMIT_INVALID')
      const dependencies = state.evidence.length + state.jobs.filter(item =>
        item.phase !== 'forgotten').length + state.revisions.filter(item =>
        item.phase !== 'tombstoned').length + state.pointers.length
      if (dependencies !== 0 || state.forgetClaims.some(item => item.phase !== 'tombstoned')) return null
      const stateHash = hash('aisy-auto-skill-state/v2', JSON.stringify(state))
      const certificateId = hash(
        'aisy-auto-skill-rollback-certificate/v1',
        JSON.stringify([stateHash, targetCommit]),
      )
      const certificate = { certificateId, stateHash, targetCommit }
      state.rollbackCertificates.push(certificate)
      persist()
      return Object.freeze(certificate)
    },

    claimNotification() {
      const item = state.notifications.find(record => record.status === 'pending')
      if (item === undefined) return null
      item.status = 'claimed'
      persist()
      return Object.freeze(structuredClone(item))
    },

    completeNotification(id, outcome) {
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

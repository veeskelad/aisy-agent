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
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export type SkillPromotionStageState =
  | 'pending'
  | 'committing'
  | 'promoted'
  | 'quarantined'
  | 'rolled_back'

export interface SkillPromotionTraceEvidence {
  evidenceId: string
  skillName: string
  artifactHash: string
  revision: number
  verifiedAt: string
}

export interface SkillPromotionStageInput {
  stageId: string
  name: string
  baseVersion: number | null
  baseArtifactHash: string | null
  candidateVersion: number
  candidateProvenance: 'human' | 'agent-authored' | 'imported'
  artifactHash: string
  artifactBase64: string
  computedDiff: string
  computedDiffHash: string
  triggerContext: { request: string; sessionId: string }
  traceEvidence: SkillPromotionTraceEvidence
  riskProof: {
    proofId: string
    artifactHash: string
    classification: 'reversible' | 'irreversible'
    classifiedAt: string
  }
  authorityProof: {
    proofId: string
    skillName: string
    artifactHash: string
    trustSource: 'builtin' | 'trusted-repo' | 'community' | 'user'
    touchedPaths: string[]
    authorizedAt: string
  }
}

export interface SkillPromotionClaim {
  claimId: string
  actionHash: string
  humanTapAuditId: string
  approvedAt: string
  stepUpSatisfied: boolean
}

export interface SkillExternalCommitReceipt {
  idempotencyKey: string
  commit: string
  recordedAt: string
}

export interface SkillPromotionAuditRecord {
  stageId: string
  actionHash: string
  artifactHash: string
  version: number
  commit: string
  humanTapAuditId: string
  approvedAt: string
}

export interface SkillPromotionStageRecord extends SkillPromotionStageInput {
  actionHash: string
  state: SkillPromotionStageState
  claim: SkillPromotionClaim | null
  externalCommit: SkillExternalCommitReceipt | null
  quarantineReason: string | null
}

export interface SkillPromotionStoreSnapshot {
  schemaVersion: 1
  stages: SkillPromotionStageRecord[]
  audits: SkillPromotionAuditRecord[]
}

export interface SkillPromotionStore {
  snapshot(): SkillPromotionStoreSnapshot
  putPending(input: SkillPromotionStageInput): SkillPromotionStageRecord
  claim(stageId: string, claim: SkillPromotionClaim): boolean
  release(stageId: string, claimId: string): boolean
  markPromoted(stageId: string, claimId: string, commit: string): boolean
  recordExternalCommit(stageId: string, claimId: string, receipt: SkillExternalCommitReceipt): boolean
  rollback(stageId: string, claimId: string, reason: string): boolean
  quarantine(stageId: string, reason: string): boolean
}

export type SkillPromotionStoreErrorCode =
  | 'CORRUPT_SKILL_PROMOTION_STORE'
  | 'INVALID_SKILL_STAGE'
  | 'DUPLICATE_SKILL_STAGE'
  | 'UNSAFE_SKILL_PROMOTION_STORE'

export class SkillPromotionStoreError extends Error {
  constructor(public readonly code: SkillPromotionStoreErrorCode) {
    super(code)
    this.name = 'SkillPromotionStoreError'
  }
}

export interface JsonSkillPromotionStoreDeps {
  exists(): boolean
  read(): string
  saveAtomic(content: string): void
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const NAME = /^[a-z0-9][a-z0-9-]*$/
const HASH = /^[a-f0-9]{64}$/
const COMMIT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/
const MAX_BYTES = 16 * 1024 * 1024
const MAX_STAGES = 2_000

function validIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index])
}

export function computePromotionActionHash(input: {
  stageId: string
  name: string
  candidateVersion: number
  candidateProvenance: SkillPromotionStageInput['candidateProvenance']
  artifactHash: string
  baseVersion: number | null
  baseArtifactHash: string | null
  computedDiffHash: string
  traceEvidence: SkillPromotionTraceEvidence
  riskProof: SkillPromotionStageInput['riskProof']
  authorityProof: SkillPromotionStageInput['authorityProof']
}): string {
  return hashText('skill.promote/v2\n' + JSON.stringify({
    stageId: input.stageId,
    name: input.name,
    baseVersion: input.baseVersion,
    baseArtifactHash: input.baseArtifactHash,
    candidateVersion: input.candidateVersion,
    candidateProvenance: input.candidateProvenance,
    artifactHash: input.artifactHash,
    computedDiffHash: input.computedDiffHash,
    traceEvidence: input.traceEvidence,
    risk: {
      proofId: input.riskProof.proofId,
      artifactHash: input.riskProof.artifactHash,
      classification: input.riskProof.classification,
      classifiedAt: input.riskProof.classifiedAt,
      stepUpRequired: input.riskProof.classification === 'irreversible',
    },
    authority: input.authorityProof,
  }))
}

function cloneRecord(record: SkillPromotionStageRecord): SkillPromotionStageRecord {
  return {
    ...record,
    triggerContext: { ...record.triggerContext },
    traceEvidence: { ...record.traceEvidence },
    riskProof: { ...record.riskProof },
    authorityProof: { ...record.authorityProof, touchedPaths: [...record.authorityProof.touchedPaths] },
    claim: record.claim ? { ...record.claim } : null,
    externalCommit: record.externalCommit ? { ...record.externalCommit } : null,
  }
}

function validateStage(value: unknown): SkillPromotionStageRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillPromotionStoreError('INVALID_SKILL_STAGE')
  }
  const item = value as Record<string, unknown>
  const context = item['triggerContext'] as Record<string, unknown> | null
  const evidence = item['traceEvidence'] as Record<string, unknown> | null
  const risk = item['riskProof'] as Record<string, unknown> | null
  const authority = item['authorityProof'] as Record<string, unknown> | null
  const claim = item['claim'] as Record<string, unknown> | null
  const receipt = item['externalCommit'] as Record<string, unknown> | null
  if (!hasExactKeys(item, [
    'stageId', 'name', 'baseVersion', 'baseArtifactHash', 'candidateVersion', 'candidateProvenance', 'artifactHash',
    'artifactBase64', 'computedDiff', 'computedDiffHash', 'triggerContext', 'traceEvidence',
    'riskProof', 'authorityProof', 'actionHash', 'state', 'claim', 'externalCommit', 'quarantineReason',
  ]) || typeof item['stageId'] !== 'string' || !ID.test(item['stageId']) ||
    typeof item['name'] !== 'string' || !NAME.test(item['name']) ||
    ((item['baseVersion'] === null) !== (item['baseArtifactHash'] === null)) ||
    (item['baseVersion'] !== null && (!Number.isInteger(item['baseVersion']) || Number(item['baseVersion']) < 1)) ||
    (item['baseArtifactHash'] !== null && (typeof item['baseArtifactHash'] !== 'string' || !HASH.test(item['baseArtifactHash']))) ||
    !Number.isInteger(item['candidateVersion']) || Number(item['candidateVersion']) < 1 ||
    !['human', 'agent-authored', 'imported'].includes(String(item['candidateProvenance'])) ||
    typeof item['artifactHash'] !== 'string' || !HASH.test(item['artifactHash']) ||
    typeof item['artifactBase64'] !== 'string' || item['artifactBase64'].length > MAX_BYTES * 2 ||
    typeof item['computedDiff'] !== 'string' || item['computedDiff'].length > MAX_BYTES ||
    typeof item['computedDiffHash'] !== 'string' || !HASH.test(item['computedDiffHash']) ||
    hashText(item['computedDiff']) !== item['computedDiffHash'] ||
    typeof context !== 'object' || context === null || !hasExactKeys(context, ['request', 'sessionId']) ||
    typeof context['request'] !== 'string' ||
    typeof context['sessionId'] !== 'string' || !ID.test(context['sessionId']) ||
    typeof evidence !== 'object' || evidence === null ||
    !hasExactKeys(evidence, ['evidenceId', 'skillName', 'artifactHash', 'revision', 'verifiedAt']) ||
    typeof evidence['evidenceId'] !== 'string' ||
    !ID.test(evidence['evidenceId']) || evidence['skillName'] !== item['name'] ||
    evidence['artifactHash'] !== item['artifactHash'] || evidence['revision'] !== item['candidateVersion'] ||
    !validIso(evidence['verifiedAt']) ||
    typeof risk !== 'object' || risk === null ||
    !hasExactKeys(risk, ['proofId', 'artifactHash', 'classification', 'classifiedAt']) ||
    typeof risk['proofId'] !== 'string' || !ID.test(risk['proofId']) ||
    risk['artifactHash'] !== item['artifactHash'] ||
    (risk['classification'] !== 'reversible' && risk['classification'] !== 'irreversible') || !validIso(risk['classifiedAt']) ||
    typeof authority !== 'object' || authority === null ||
    !hasExactKeys(authority, ['proofId', 'skillName', 'artifactHash', 'trustSource', 'touchedPaths', 'authorizedAt']) ||
    typeof authority['proofId'] !== 'string' ||
    !ID.test(authority['proofId']) || authority['skillName'] !== item['name'] ||
    authority['artifactHash'] !== item['artifactHash'] ||
    !['builtin', 'trusted-repo', 'community', 'user'].includes(String(authority['trustSource'])) ||
    !Array.isArray(authority['touchedPaths']) || authority['touchedPaths'].some(path =>
      typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
      path.split('/').some(part => part === '' || part === '.' || part === '..')) ||
    !validIso(authority['authorizedAt']) ||
    typeof item['actionHash'] !== 'string' || !HASH.test(item['actionHash']) ||
    !['pending', 'committing', 'promoted', 'quarantined', 'rolled_back'].includes(String(item['state'])) ||
    (item['quarantineReason'] !== null && typeof item['quarantineReason'] !== 'string')) {
    throw new SkillPromotionStoreError('INVALID_SKILL_STAGE')
  }
  let decoded: Buffer
  try { decoded = Buffer.from(item['artifactBase64'], 'base64') } catch {
    throw new SkillPromotionStoreError('INVALID_SKILL_STAGE')
  }
  if (decoded.length > MAX_BYTES || decoded.toString('base64') !== item['artifactBase64'] ||
    createHash('sha256').update(decoded).digest('hex') !== item['artifactHash']) {
    throw new SkillPromotionStoreError('INVALID_SKILL_STAGE')
  }
  const expectedActionHash = computePromotionActionHash({
    stageId: item['stageId'],
    name: item['name'],
    candidateVersion: Number(item['candidateVersion']),
    candidateProvenance: item['candidateProvenance'] as SkillPromotionStageInput['candidateProvenance'],
    artifactHash: item['artifactHash'],
    baseVersion: item['baseVersion'] as number | null,
    baseArtifactHash: item['baseArtifactHash'] as string | null,
    computedDiffHash: item['computedDiffHash'] as string,
    traceEvidence: evidence as unknown as SkillPromotionTraceEvidence,
    riskProof: risk as unknown as SkillPromotionStageInput['riskProof'],
    authorityProof: authority as unknown as SkillPromotionStageInput['authorityProof'],
  })
  if (item['actionHash'] !== expectedActionHash ||
    Number(item['candidateVersion']) !== (item['baseVersion'] === null ? 1 : Number(item['baseVersion']) + 1)) {
    throw new SkillPromotionStoreError('INVALID_SKILL_STAGE')
  }
  if (claim !== null && (typeof claim !== 'object' ||
    !hasExactKeys(claim, ['claimId', 'actionHash', 'humanTapAuditId', 'approvedAt', 'stepUpSatisfied']) ||
    typeof claim['claimId'] !== 'string' || !ID.test(claim['claimId']) ||
    claim['actionHash'] !== item['actionHash'] || typeof claim['humanTapAuditId'] !== 'string' ||
    !ID.test(claim['humanTapAuditId']) || !validIso(claim['approvedAt']) || typeof claim['stepUpSatisfied'] !== 'boolean' ||
    (risk['classification'] === 'irreversible' && claim['stepUpSatisfied'] !== true))) {
    throw new SkillPromotionStoreError('INVALID_SKILL_STAGE')
  }
  if (receipt !== null && (typeof receipt !== 'object' ||
    !hasExactKeys(receipt, ['idempotencyKey', 'commit', 'recordedAt']) ||
    receipt['idempotencyKey'] !== item['actionHash'] ||
    typeof receipt['commit'] !== 'string' || !COMMIT.test(receipt['commit']) || !validIso(receipt['recordedAt']))) {
    throw new SkillPromotionStoreError('INVALID_SKILL_STAGE')
  }
  if ((item['state'] === 'pending' || item['state'] === 'rolled_back') && (claim !== null || receipt !== null) ||
    item['state'] === 'committing' && claim === null ||
    item['state'] === 'promoted' && (claim === null || receipt === null)) {
    throw new SkillPromotionStoreError('INVALID_SKILL_STAGE')
  }
  return cloneRecord({
    stageId: item['stageId'], name: item['name'],
    baseVersion: item['baseVersion'] as number | null,
    baseArtifactHash: item['baseArtifactHash'] as string | null,
    candidateVersion: Number(item['candidateVersion']),
    candidateProvenance: item['candidateProvenance'] as SkillPromotionStageInput['candidateProvenance'],
    artifactHash: item['artifactHash'],
    artifactBase64: item['artifactBase64'],
    computedDiff: item['computedDiff'], computedDiffHash: item['computedDiffHash'],
    triggerContext: { request: context['request'], sessionId: context['sessionId'] },
    traceEvidence: {
      evidenceId: evidence['evidenceId'] as string,
      skillName: evidence['skillName'] as string,
      artifactHash: evidence['artifactHash'] as string,
      revision: Number(evidence['revision']),
      verifiedAt: evidence['verifiedAt'] as string,
    },
    riskProof: risk as unknown as SkillPromotionStageInput['riskProof'],
    authorityProof: {
      ...(authority as unknown as SkillPromotionStageInput['authorityProof']),
      touchedPaths: [...(authority['touchedPaths'] as string[])],
    },
    actionHash: item['actionHash'],
    state: item['state'] as SkillPromotionStageState,
    claim: claim === null ? null : {
      claimId: claim['claimId'] as string,
      actionHash: claim['actionHash'] as string,
      humanTapAuditId: claim['humanTapAuditId'] as string,
      approvedAt: claim['approvedAt'] as string,
      stepUpSatisfied: claim['stepUpSatisfied'] as boolean,
    },
    externalCommit: receipt === null ? null : {
      idempotencyKey: receipt['idempotencyKey'] as string,
      commit: receipt['commit'] as string,
      recordedAt: receipt['recordedAt'] as string,
    },
    quarantineReason: item['quarantineReason'] as string | null,
  })
}

function validateAudit(value: unknown): SkillPromotionAuditRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE')
  }
  const item = value as Record<string, unknown>
  if (!hasExactKeys(item, [
    'stageId', 'actionHash', 'artifactHash', 'version', 'commit', 'humanTapAuditId', 'approvedAt',
  ]) || typeof item['stageId'] !== 'string' || !ID.test(item['stageId']) ||
    typeof item['actionHash'] !== 'string' || !HASH.test(item['actionHash']) ||
    typeof item['artifactHash'] !== 'string' || !HASH.test(item['artifactHash']) ||
    !Number.isInteger(item['version']) || Number(item['version']) < 1 ||
    typeof item['commit'] !== 'string' || !COMMIT.test(item['commit']) ||
    typeof item['humanTapAuditId'] !== 'string' || !ID.test(item['humanTapAuditId']) ||
    !validIso(item['approvedAt'])) {
    throw new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE')
  }
  return item as unknown as SkillPromotionAuditRecord
}

function validateSnapshot(value: unknown): SkillPromotionStoreSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE')
  }
  const item = value as Record<string, unknown>
  if (!hasExactKeys(item, ['schemaVersion', 'stages', 'audits']) || item['schemaVersion'] !== 1 ||
    !Array.isArray(item['stages']) || !Array.isArray(item['audits']) ||
    item['stages'].length > MAX_STAGES || item['audits'].length > MAX_STAGES) {
    throw new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE')
  }
  try {
    const stages = item['stages'].map(validateStage)
    const audits = item['audits'].map(validateAudit)
    const ids = new Set(stages.map(stage => stage.stageId))
    if (ids.size !== stages.length || new Set(audits.map(audit => audit.stageId)).size !== audits.length) {
      throw new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE')
    }
    for (const audit of audits) {
      const stage = stages.find(candidate => candidate.stageId === audit.stageId)
      if (!stage || stage.state !== 'promoted' || stage.actionHash !== audit.actionHash ||
        stage.artifactHash !== audit.artifactHash || stage.candidateVersion !== audit.version ||
        stage.externalCommit?.commit !== audit.commit || stage.claim?.humanTapAuditId !== audit.humanTapAuditId ||
        stage.claim.approvedAt !== audit.approvedAt) {
        throw new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE')
      }
    }
    return { schemaVersion: 1, stages, audits }
  } catch (error) {
    if (error instanceof SkillPromotionStoreError && error.code === 'CORRUPT_SKILL_PROMOTION_STORE') throw error
    throw new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE')
  }
}

export function makeJsonSkillPromotionStore(deps: JsonSkillPromotionStoreDeps): SkillPromotionStore {
  let state: SkillPromotionStoreSnapshot = { schemaVersion: 1, stages: [], audits: [] }
  if (deps.exists()) {
    try {
      const raw = deps.read()
      if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('oversized')
      state = validateSnapshot(JSON.parse(raw) as unknown)
    } catch (error) {
      if (error instanceof SkillPromotionStoreError && error.code === 'CORRUPT_SKILL_PROMOTION_STORE') throw error
      throw new SkillPromotionStoreError('CORRUPT_SKILL_PROMOTION_STORE')
    }
  }
  const publish = (next: SkillPromotionStoreSnapshot): void => {
    const validated = validateSnapshot(next)
    const content = JSON.stringify(validated, null, 2) + '\n'
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      throw new SkillPromotionStoreError('INVALID_SKILL_STAGE')
    }
    deps.saveAtomic(content)
    state = validated
  }
  const replaceStage = (stage: SkillPromotionStageRecord): void => {
    publish({ ...state, stages: state.stages.map(item => item.stageId === stage.stageId ? stage : item) })
  }
  return Object.freeze<SkillPromotionStore>({
    snapshot: () => Object.freeze({
      schemaVersion: 1 as const,
      stages: state.stages.map(cloneRecord),
      audits: state.audits.map(item => ({ ...item })),
    }),
    putPending(input) {
      if (state.stages.some(stage => stage.stageId === input.stageId)) {
        throw new SkillPromotionStoreError('DUPLICATE_SKILL_STAGE')
      }
      const actionHash = computePromotionActionHash(input)
      const record = validateStage({
        ...input, actionHash, state: 'pending', claim: null, externalCommit: null, quarantineReason: null,
      })
      publish({ ...state, stages: [...state.stages, record].sort((a, b) => a.stageId.localeCompare(b.stageId)) })
      return cloneRecord(record)
    },
    claim(stageId, claim) {
      const record = state.stages.find(stage => stage.stageId === stageId)
      if (!record || record.state !== 'pending' || claim.actionHash !== record.actionHash) return false
      replaceStage(validateStage({ ...record, state: 'committing', claim: { ...claim } }))
      return true
    },
    release(stageId, claimId) {
      const record = state.stages.find(stage => stage.stageId === stageId)
      if (!record || record.state !== 'committing' || record.claim?.claimId !== claimId || record.externalCommit !== null) return false
      replaceStage(validateStage({ ...record, state: 'pending', claim: null }))
      return true
    },
    recordExternalCommit(stageId, claimId, receipt) {
      const record = state.stages.find(stage => stage.stageId === stageId)
      if (!record || record.state !== 'committing' || record.claim?.claimId !== claimId ||
        (record.externalCommit !== null && (record.externalCommit.commit !== receipt.commit ||
          record.externalCommit.idempotencyKey !== receipt.idempotencyKey))) return false
      replaceStage(validateStage({ ...record, externalCommit: { ...receipt } }))
      return true
    },
    markPromoted(stageId, claimId, commit) {
      const record = state.stages.find(stage => stage.stageId === stageId)
      if (!record || record.state !== 'committing' || record.claim?.claimId !== claimId ||
        record.externalCommit?.commit !== commit || !COMMIT.test(commit)) return false
      const promoted = validateStage({ ...record, state: 'promoted' })
      const audit: SkillPromotionAuditRecord = {
        stageId, actionHash: record.actionHash, artifactHash: record.artifactHash,
        version: record.candidateVersion, commit,
        humanTapAuditId: record.claim.humanTapAuditId, approvedAt: record.claim.approvedAt,
      }
      publish({
        ...state,
        stages: state.stages.map(item => item.stageId === stageId ? promoted : item),
        audits: [...state.audits.filter(item => item.stageId !== stageId), audit]
          .sort((a, b) => a.stageId.localeCompare(b.stageId)),
      })
      return true
    },
    rollback(stageId, claimId, reason) {
      const record = state.stages.find(stage => stage.stageId === stageId)
      if (!record || record.claim?.claimId !== claimId || record.state === 'promoted' || record.externalCommit !== null) return false
      replaceStage(validateStage({
        ...record, state: 'rolled_back', claim: null, externalCommit: null, quarantineReason: reason,
      }))
      return true
    },
    quarantine(stageId, reason) {
      const record = state.stages.find(stage => stage.stageId === stageId)
      if (!record || record.state === 'promoted') return false
      replaceStage(validateStage({
        ...record, state: 'quarantined', quarantineReason: reason,
      }))
      return true
    },
  })
}

function syncPath(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new SkillPromotionStoreError('UNSAFE_SKILL_PROMOTION_STORE')
  }
  chmodSync(path, 0o700)
}

function assertPrivateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES ||
    realpathSync(path) !== path || (stat.mode & 0o077) !== 0) {
    throw new SkillPromotionStoreError('UNSAFE_SKILL_PROMOTION_STORE')
  }
}

export function makeNodeSkillPromotionStore(input: { path: string }): SkillPromotionStore {
  const requestedPath = resolve(input.path)
  const requestedDirectory = dirname(requestedPath)
  mkdirSync(requestedDirectory, { recursive: true, mode: 0o700 })
  const directory = realpathSync(requestedDirectory)
  const path = join(directory, basename(requestedPath))
  assertPrivateDirectory(directory)
  if (existsSync(path)) assertPrivateFile(path)
  return makeJsonSkillPromotionStore({
    exists: () => existsSync(path),
    read: () => readFileSync(path, 'utf8'),
    saveAtomic(content) {
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
      writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      syncPath(temporary)
      renameSync(temporary, path)
      syncPath(directory)
    },
  })
}

export type SkillPromotionStoreInspection = Readonly<{
  status: 'absent' | 'ready' | 'corrupt' | 'unsafe'
  pending: number
  committing: number
  promoted: number
  quarantined: number
}>

export function inspectNodeSkillPromotionStore(pathInput: string): SkillPromotionStoreInspection {
  const requestedPath = resolve(pathInput)
  const requestedDirectory = dirname(requestedPath)
  const path = existsSync(requestedDirectory)
    ? join(realpathSync(requestedDirectory), basename(requestedPath))
    : requestedPath
  if (!existsSync(path)) return Object.freeze({ status: 'absent', pending: 0, committing: 0, promoted: 0, quarantined: 0 })
  try {
    assertPrivateFile(path)
    const raw = readFileSync(path, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('oversized')
    const state = validateSnapshot(JSON.parse(raw) as unknown)
    return Object.freeze({
      status: 'ready' as const,
      pending: state.stages.filter(item => item.state === 'pending').length,
      committing: state.stages.filter(item => item.state === 'committing').length,
      promoted: state.stages.filter(item => item.state === 'promoted').length,
      quarantined: state.stages.filter(item => item.state === 'quarantined' || item.state === 'rolled_back').length,
    })
  } catch (error) {
    const status = error instanceof SkillPromotionStoreError && error.code === 'UNSAFE_SKILL_PROMOTION_STORE'
      ? 'unsafe' as const : 'corrupt' as const
    return Object.freeze({ status, pending: 0, committing: 0, promoted: 0, quarantined: 0 })
  }
}
